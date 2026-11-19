# Loom Android APK

Carl's phone runs a Loom APK that the production machine builds itself. Upstream's store builds and over-the-air (EAS) updates do not apply to Loom: `updates.url` in `apps/mobile/app.config.ts` points at upstream's Expo project, so an over-the-air update would replace Loom's app code with upstream's. Updates are switched off in every Loom build, and any change to the app reaches the phone only as a new APK.

## How an APK is built

At the end of a deploy, after the five-minute watch has passed, `loom-deploy` asks whether a stored APK matches the app code of the release now running (`apps/server/src/loom/deploy/mobile.ts`, `appChanged`). If one does, the server offers it and nothing is built. If none does, a build of that release's commit starts in its own unit, `loom-mobile-build.service`, at low priority. A deploy never waits for it and never fails because of it. The same question is asked after `loom-deploy back` and by `loom-deploy apk`.

The build needs the `mobile` key in `~/loom-releases/deploy.json` (`deploy/README.md`); without it nothing is built. Everything it writes is under that key's `dir`, on `/mnt/fast`: the checkout (`build/`, removed when the build ends), the package store, Gradle's home, caches, the stored APKs (`apks/`) and the last build's whole output (`build.log`). It refuses to start with under 30 GB free on that disk. A first build on a machine downloads every package and Gradle dependency once.

The phone hears through `<stateDir>/mobile-app.json`, which the build writes and the server streams to the app. The app shows a notice when the matching APK is not the build it runs.

## The six checks

An APK is published only if all of these hold; otherwise the build is recorded as failed with the reason, and nothing changes on the phone except the failure notice.

| Check                | Must be                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| Package              | `com.t3tools.t3code.preview`                                               |
| Version code         | `1`, so an older Loom APK always installs over a newer one                 |
| Signing certificate  | SHA-256 `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c` |
| Updates through Expo | `expo.modules.updates.ENABLED` is `false`                                  |
| Install permission   | `android.permission.REQUEST_INSTALL_PACKAGES` is declared                  |
| Build stamp          | `extra.loomBuild.sha` in `assets/app.config` is the commit built           |

The certificate is the debug key in the `expo` package's prebuild template. A different certificate means Android refuses to update in place and Carl would lose his pairing, so an Expo bump that changed that key shows here as a failed build.

## When a build fails

`loom-deploy status` shows the phone app's line: the APK on offer, a build in progress, or the failure's reason. The whole output is `<mobile dir>/build.log`, and the unit's own lines are in `journalctl --user -u loom-mobile-build`. After a fix is deployed, the next deploy builds again; to retry without a deploy, run `loom-deploy apk`.

The build never installs Android SDK components itself, since the SDK sits on the root disk. When an Expo or React Native bump needs an NDK, platform or build-tools version that is not installed, the build fails and `build.log` names it: install it with `sdkmanager` (on the path from `/etc/profile.d/android-sdk.sh`), check the root disk has room, then run `loom-deploy apk`.

## Handing an APK over by hand

When the app will not open, or a phone needs its first Loom APK, give Carl a stored file: `<mobile dir>/apks/loom-<sha7>.apk`. There are at most two, the newest and the one before; the one before is the way back. The last hand handovers went as a GitHub pre-release on `QuinRiva/loom`.

When the app change depends on something the server serves, the server must be deployed first, which the deploy's own build guarantees.

## What the build runs

For reference when a build fails in a step: from a fresh checkout of the commit, with `APP_VARIANT=preview`, `T3CODE_MOBILE_UPDATES_ENABLED=0`, `LOOM_BUILD_SHA` and `LOOM_BUILD_COMMITTED_AT` set,

```bash
pnpm install --frozen-lockfile --store-dir <mobile dir>/pnpm-store
cd apps/mobile && EXPO_NO_GIT_STATUS=1 CI=1 npx expo prebuild --clean --platform android
cd android && NODE_ENV=production ./gradlew assembleRelease --no-daemon -PreactNativeArchitectures=arm64-v8a "-Dorg.gradle.jvmargs=-Xmx8g -XX:MaxMetaspaceSize=2g"
```

with `ANDROID_HOME` and `JAVA_HOME` from `deploy.json`. The APK lands at `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`. A build by hand without `LOOM_BUILD_SHA` has no build stamp and no install permission, so the app shows its build as not recorded.
