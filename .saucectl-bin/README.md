# saucectl Bundled Binaries

This directory holds the platform-specific saucectl binaries that electron-builder
includes via `extraResources` in the packaged app. Each build target pulls only its
own platform+arch binary.

## Directory structure

```
.saucectl-bin/
  mac/
    x64/saucectl          # darwin x64
    arm64/saucectl        # darwin arm64 (Apple Silicon)
  win/
    x64/saucectl.exe      # Windows x64
  linux/
    x64/saucectl          # Linux x64
```

## How to obtain the binaries

1. Go to https://github.com/saucelabs/saucectl/releases
2. Download the release that satisfies the `SAUCELABS_COMPATIBLE_SAUCECTL_RANGE`
   defined in `src/config/defaults.js`.
3. Extract the binary from each platform-specific archive and place it in the
   corresponding directory above:

| Archive                                    | Place extracted binary at          |
|--------------------------------------------|------------------------------------|
| `saucectl_{ver}_mac_64-bit.tar.gz`         | `.saucectl-bin/mac/x64/saucectl`   |
| `saucectl_{ver}_mac_arm64.tar.gz`          | `.saucectl-bin/mac/arm64/saucectl` |
| `saucectl_{ver}_win_64-bit.zip`            | `.saucectl-bin/win/x64/saucectl.exe` |
| `saucectl_{ver}_linux_64-bit.tar.gz`       | `.saucectl-bin/linux/x64/saucectl` |

4. Ensure macOS/Linux binaries have executable permission (`chmod +x`).

## Build behavior

- `electron-builder` uses the `${os}/${arch}` macros to select the correct
  subdirectory for each build target automatically.
- The binary lands at `<app>/Contents/Resources/saucectl/saucectl` (macOS) or
  `<install-dir>/resources/saucectl/saucectl.exe` (Windows).
- If the binary is missing at build time, `scripts/check-env.js` emits a warning
  but does NOT fail the build. CI can package without saucectl present; users will
  fall through to Level 3 (PATH) or Level 4 (error) at runtime.
