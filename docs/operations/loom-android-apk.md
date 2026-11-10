# Loom Android APK

Carl's phone runs a Loom APK built on the cockpit server and installed by hand. Upstream's store builds and over-the-air (EAS) updates do not apply to Loom: `updates.url` in `apps/mobile/app.config.ts` points at upstream's Expo project, so an over-the-air update would replace Loom's app code with upstream's. Updates are switched off in every Loom build, and any change to the app reaches the phone only as a new APK.

## Build

The preview variant (`com.t3tools.t3code.preview`, "T3 Code Preview"), arm64 only, signed with the debug key, with the JavaScript bundle embedded. About six minutes with warm caches; run it in the background.

```bash
. /etc/profile.d/android-sdk.sh
export JAVA_HOME=$ANDROID_JAVA_HOME APP_VARIANT=preview T3CODE_MOBILE_UPDATES_ENABLED=0
cd apps/mobile && EXPO_NO_GIT_STATUS=1 CI=1 npx expo prebuild --clean --platform android
cd android && NODE_ENV=production ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a "-Dorg.gradle.jvmargs=-Xmx8g -XX:MaxMetaspaceSize=2g"
```

The APK lands at `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`. Copy it to a fresh name under the worktree's `.artifacts/` and never overwrite an earlier one: the previous APK is the way back.

## Before handing it over

- Updates are off: `aapt2 dump xmltree --file AndroidManifest.xml <apk>` shows `expo.modules.updates.ENABLED` false. `T3CODE_MOBILE_UPDATES_ENABLED=0` must be exported for both steps, since Gradle also writes the app config into the APK.
- Same signing certificate as the installed build: compare `apksigner verify --print-certs` against the previous APK. A different certificate means Android refuses to update in place, and Carl would have to uninstall and lose his pairing.

## Order of install

When the app change depends on something the server serves (the `.mdx` document viewer page does), the server is deployed first and the APK installed after. An APK newer than its server shows the feature as unavailable until the deploy. Hand back the previous APK's path with every new one; installing it again restores the earlier app.
