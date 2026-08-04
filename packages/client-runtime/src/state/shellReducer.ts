import * as Arr from "effect/Array";
import type { OrchestrationShellSnapshot, OrchestrationShellStreamEvent } from "@t3tools/contracts";

/**
 * Reduce a single shell stream event into an existing snapshot, returning a new
 * snapshot with the event's changes applied. This is a pure reducer that both
 * web and mobile can use to keep their local shell snapshot in sync.
 *
 * Returns the original snapshot reference unchanged if the event is not
 * recognized (forward-compatible).
 */
export function applyShellStreamEvent(
  snapshot: OrchestrationShellSnapshot,
  event: OrchestrationShellStreamEvent,
): OrchestrationShellSnapshot {
  if (event.sequence <= snapshot.snapshotSequence) return snapshot;

  switch (event.kind) {
    case "project-upserted": {
      const projects = snapshot.projects.some((p) => p.id === event.project.id)
        ? Arr.map(snapshot.projects, (p) => (p.id === event.project.id ? event.project : p))
        : Arr.append(snapshot.projects, event.project);
      return { ...snapshot, projects, snapshotSequence: event.sequence };
    }
    case "project-removed":
      return {
        ...snapshot,
        projects: Arr.filter(snapshot.projects, (p) => p.id !== event.projectId),
        snapshotSequence: event.sequence,
      };
    case "thread-upserted": {
      // One domain event can carry several shells (see the contract): the thread
      // it happened to, plus any whose graph-DERIVED fields its transition
      // changed. Merge them all under the single sequence.
      const byId = new Map(event.threads.map((t) => [t.id, t] as const));
      const merged = Arr.map(snapshot.threads, (t) => byId.get(t.id) ?? t);
      const added = event.threads.filter((t) => !snapshot.threads.some((s) => s.id === t.id));
      return {
        ...snapshot,
        threads: added.length === 0 ? merged : Arr.appendAll(merged, added),
        snapshotSequence: event.sequence,
      };
    }
    case "thread-removed":
      return {
        ...snapshot,
        threads: Arr.filter(snapshot.threads, (t) => t.id !== event.threadId),
        snapshotSequence: event.sequence,
      };
    case "goal-upserted": {
      const goals = snapshot.goals.some((g) => g.id === event.goal.id)
        ? Arr.map(snapshot.goals, (g) => (g.id === event.goal.id ? event.goal : g))
        : Arr.append(snapshot.goals, event.goal);
      return { ...snapshot, goals, snapshotSequence: event.sequence };
    }
    case "goal-removed":
      return {
        ...snapshot,
        goals: Arr.filter(snapshot.goals, (g) => g.id !== event.goalId),
        snapshotSequence: event.sequence,
      };
    default:
      return snapshot;
  }
}
