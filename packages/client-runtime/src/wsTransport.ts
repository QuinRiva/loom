import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { RpcClient } from "effect/unstable/rpc";
import { WS_METHODS } from "@t3tools/contracts";

import { isTransportConnectionErrorMessage } from "./transportError.ts";
import {
  createWsRpcProtocolLayer,
  makeWsRpcProtocolClient,
  type WsProtocolLifecycleHandlers,
  type WsRpcProtocolClient,
  type WsRpcProtocolSocketUrlProvider,
} from "./wsRpcProtocol.ts";

export interface WsTransportOptions {
  /**
   * Merged into the transport `ManagedRuntime` alongside the RPC protocol layer
   * (for example a `Tracer` layer for OTLP).
   */
  readonly tracingLayer?: Layer.Layer<never, never, never>;
  /**
   * Override protocol construction (defaults to {@link createWsRpcProtocolLayer}).
   * The web app supplies its instrumented layer factory.
   */
  readonly createProtocolLayer?: (
    url: WsRpcProtocolSocketUrlProvider,
    lifecycleHandlers?: WsProtocolLifecycleHandlers,
  ) => Layer.Layer<RpcClient.Protocol, never, never>;
  readonly logWarning?: (message: string, metadata: { readonly error: string }) => void;
  /**
   * Invoked at the start of {@link WsTransport.reconnect} before the session is replaced.
   */
  readonly onBeforeReconnect?: () => void;
  /**
   * Cadence of the keepalive heartbeat RPC. Must stay comfortably below the
   * idle-reap threshold (~30s) and below the {@link WsTransport.isHeartbeatFresh}
   * window so freshness holds between beats. Defaults to 8s: even a slow-but-alive
   * beat that nears the per-beat timeout keeps the inter-success gap (8s + ~5s)
   * under the 15s freshness window, avoiding spurious resume-reconnects.
   */
  readonly heartbeatIntervalMs?: number;
  /** Per-beat timeout so a stalled beat cannot overlap the next one. Defaults to 5s. */
  readonly heartbeatTimeoutMs?: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 8_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000;

interface SubscribeOptions {
  readonly retryDelay?: Duration.Input;
  readonly onResubscribe?: () => void;
  readonly tag?: string;
}

const DEFAULT_SUBSCRIPTION_RETRY_DELAY = Duration.millis(250);
const NOOP: () => void = () => undefined;

interface TransportSession {
  readonly clientPromise: Promise<WsRpcProtocolClient>;
  readonly clientScope: Scope.Closeable;
  readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}

export class WsTransport {
  private readonly url: WsRpcProtocolSocketUrlProvider;
  private readonly lifecycleHandlers: WsProtocolLifecycleHandlers | undefined;
  private readonly options: WsTransportOptions | undefined;
  private disposed = false;
  private hasReportedTransportDisconnect = false;
  private intentionalCloseDepth = 0;
  private nextSessionId = 0;
  private activeSessionId = 0;
  private lastHeartbeatPongAt: number | null = null;
  private readonly streamRequestStartListeners = new Set<
    (info: { readonly tag: string }) => void
  >();
  private reconnectChain: Promise<void> = Promise.resolve();
  private session: TransportSession;

  constructor(
    url: WsRpcProtocolSocketUrlProvider,
    lifecycleHandlers?: WsProtocolLifecycleHandlers,
    options?: WsTransportOptions,
  ) {
    this.url = url;
    this.lifecycleHandlers = lifecycleHandlers;
    this.options = options;
    this.session = this.createSession();
  }

  async request<TSuccess>(
    execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const session = this.session;
    const client = await session.clientPromise;
    return await session.runtime.runPromise(Effect.suspend(() => execute(client)));
  }

  async requestStream<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
  ): Promise<void> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const session = this.session;
    const client = await session.clientPromise;
    await session.runtime.runPromise(
      Stream.runForEach(connect(client), (value) =>
        Effect.sync(() => {
          try {
            listener(value);
          } catch {
            // Ignore listener errors so the stream can finish cleanly.
          }
        }),
      ),
    );
  }

  subscribe<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    options?: SubscribeOptions,
  ): () => void {
    if (this.disposed) {
      return NOOP;
    }

    let active = true;
    let hasReceivedValue = false;
    const retryDelayMs = Duration.toMillis(
      Duration.fromInputUnsafe(options?.retryDelay ?? DEFAULT_SUBSCRIPTION_RETRY_DELAY),
    );
    let cancelCurrentStream: () => void = NOOP;
    const onStreamRequestStart = (info: { readonly tag: string }) => {
      if (
        !hasReceivedValue ||
        !active ||
        (options?.tag !== undefined && info.tag !== options.tag)
      ) {
        return;
      }

      try {
        options?.onResubscribe?.();
      } catch {
        // Ignore reconnect hook failures so the stream can recover.
      }
    };
    this.streamRequestStartListeners.add(onStreamRequestStart);

    void (async () => {
      for (;;) {
        if (!active || this.disposed) {
          return;
        }

        const session = this.session;
        try {
          if (hasReceivedValue) {
            try {
              options?.onResubscribe?.();
            } catch {
              // Ignore reconnect hook failures so the stream can recover.
            }
          }
          const runningStream = this.runStreamOnSession(
            session,
            connect,
            listener,
            () => active,
            () => {
              this.hasReportedTransportDisconnect = false;
              hasReceivedValue = true;
            },
          );
          cancelCurrentStream = runningStream.cancel;
          await runningStream.completed;
          cancelCurrentStream = NOOP;
        } catch (error) {
          cancelCurrentStream = NOOP;
          if (!active || this.disposed) {
            return;
          }

          // Skip retry if the session has already been replaced by a reconnect.
          if (session !== this.session) {
            continue;
          }

          const formattedError = formatErrorMessage(error);
          if (!isTransportConnectionErrorMessage(formattedError)) {
            this.logWarning("WebSocket RPC subscription failed", { error: formattedError });
            return;
          }

          if (!this.hasReportedTransportDisconnect) {
            this.logWarning("WebSocket RPC subscription disconnected", {
              error: formattedError,
            });
          }
          this.hasReportedTransportDisconnect = true;
          await sleep(retryDelayMs);
        }
      }
    })();

    return () => {
      active = false;
      this.streamRequestStartListeners.delete(onStreamRequestStart);
      cancelCurrentStream();
    };
  }

  async reconnect() {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const reconnectOperation = this.reconnectChain.then(async () => {
      if (this.disposed) {
        throw new Error("Transport disposed");
      }

      try {
        this.options?.onBeforeReconnect?.();
      } catch {
        // Ignore hook failures so reconnect can proceed.
      }

      this.lastHeartbeatPongAt = null;
      const previousSession = this.session;
      this.session = this.createSession();
      await this.closeSession(previousSession);
    });

    this.reconnectChain = reconnectOperation.catch(() => undefined);
    await reconnectOperation;
  }

  isHeartbeatFresh(maxAgeMs = 15_000): boolean {
    return (
      this.lastHeartbeatPongAt !== null && performance.now() - this.lastHeartbeatPongAt <= maxAgeMs
    );
  }

  async dispose() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    await this.closeSession(this.session);
  }

  private closeSession(session: TransportSession) {
    this.intentionalCloseDepth += 1;
    return session.runtime.runPromise(Scope.close(session.clientScope, Exit.void)).finally(() => {
      this.intentionalCloseDepth = Math.max(0, this.intentionalCloseDepth - 1);
      session.runtime.dispose();
    });
  }

  private createSession(): TransportSession {
    const protocolFactory = this.options?.createProtocolLayer ?? createWsRpcProtocolLayer;
    const sessionId = this.nextSessionId + 1;
    this.nextSessionId = sessionId;
    this.activeSessionId = sessionId;
    const lifecycleHandlers = this.lifecycleHandlers;
    const protocolLayer = protocolFactory(this.url, {
      ...lifecycleHandlers,
      isActive: () =>
        !this.disposed &&
        this.activeSessionId === sessionId &&
        (lifecycleHandlers?.isActive?.() ?? true),
      isCloseIntentional: () =>
        this.disposed ||
        this.intentionalCloseDepth > 0 ||
        lifecycleHandlers?.isCloseIntentional?.() === true,
      onRequestStart: (info) => {
        lifecycleHandlers?.onRequestStart?.(info);
        if (!info.stream) {
          return;
        }
        for (const listener of this.streamRequestStartListeners) {
          listener({ tag: info.tag });
        }
      },
    });
    const rootLayer = this.options?.tracingLayer
      ? Layer.mergeAll(protocolLayer, this.options.tracingLayer)
      : protocolLayer;
    const runtime = ManagedRuntime.make(rootLayer);
    const clientScope = runtime.runSync(Scope.make());
    const clientPromise = runtime.runPromise(Scope.provide(clientScope)(makeWsRpcProtocolClient));
    this.startHeartbeat({ runtime, clientScope, clientPromise, sessionId });
    return { runtime, clientScope, clientPromise };
  }

  /**
   * Self-rescheduling keepalive loop scoped to the session's client scope. Each
   * iteration sleeps the interval, then awaits one heartbeat RPC (with a per-beat
   * timeout) before looping, so beats never overlap. On success it refreshes
   * {@link lastHeartbeatPongAt}.
   * Failures/timeouts are swallowed — a genuinely dead socket is handled by the
   * existing reconnect path, not by throwing into app code. The loop is forked
   * into `clientScope`, so `closeSession` (reconnect/dispose) interrupts it
   * cleanly with no leaked fibers across the reconnect chain.
   */
  private startHeartbeat(session: {
    readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
    readonly clientScope: Scope.Closeable;
    readonly clientPromise: Promise<WsRpcProtocolClient>;
    readonly sessionId: number;
  }) {
    const intervalMs = this.options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const timeoutMs = this.options?.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    const lifecycleHandlers = this.lifecycleHandlers;
    const recordHeartbeat = () => {
      if (this.disposed || this.activeSessionId !== session.sessionId) {
        return;
      }
      this.lastHeartbeatPongAt = performance.now();
      try {
        lifecycleHandlers?.onHeartbeatPong?.();
      } catch {
        // Ignore consumer hook failures so the heartbeat loop stays alive.
      }
    };
    const heartbeatLoop = Effect.flatMap(
      Effect.promise(() => session.clientPromise),
      (client) =>
        Effect.forever(
          Effect.flatMap(Effect.sleep(Duration.millis(intervalMs)), () =>
            client[WS_METHODS.heartbeat]({}).pipe(
              Effect.timeout(Duration.millis(timeoutMs)),
              Effect.flatMap(() => Effect.sync(recordHeartbeat)),
              Effect.ignore,
            ),
          ),
        ),
    );
    session.runtime.runFork(Scope.provide(session.clientScope)(Effect.forkScoped(heartbeatLoop)));
  }

  private logWarning(message: string, metadata: { readonly error: string }) {
    const logWarning = this.options?.logWarning;
    if (logWarning) {
      logWarning(message, metadata);
    } else {
      Effect.runSync(Effect.logWarning(message, metadata));
    }
  }

  private runStreamOnSession<TValue>(
    session: TransportSession,
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    isActive: () => boolean,
    markValueReceived: () => void,
  ): {
    readonly cancel: () => void;
    readonly completed: Promise<void>;
  } {
    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: unknown) => void;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    const cancel = session.runtime.runCallback(
      Effect.promise(() => session.clientPromise).pipe(
        Effect.flatMap((client) =>
          Stream.runForEach(connect(client), (value) =>
            Effect.sync(() => {
              if (!isActive()) {
                return;
              }

              markValueReceived();
              try {
                listener(value);
              } catch {
                // Ignore listener errors so the stream stays live.
              }
            }),
          ),
        ),
      ),
      {
        onExit: (exit) => {
          if (Exit.isSuccess(exit)) {
            resolveCompleted();
            return;
          }

          rejectCompleted(Cause.squash(exit.cause));
        },
      },
    );

    return {
      cancel,
      completed,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return Effect.runPromise(Effect.sleep(Duration.millis(ms)));
}
