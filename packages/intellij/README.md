# IntelliJ JCEF package

This package builds an IntelliJ plugin archive whose Tool Window hosts the Paseo web UI in JCEF.
The UI is exported from this checkout (`packages/app`, Paseo 0.15.0); it is not the old preview
UI bundle.

## Build

First build the app assets from source:

```sh
npm run build:web --workspace=@getpaseo/app
```

Then package the app with the installed JCEF host plugin JAR:

```sh
packages/intellij/scripts/package-jcef.sh
```

The script uses the installed 0.1.2 host JAR by default. Set `PASEO_JCEF_HOST_JAR` to another
compatible host JAR, or `IDEA_HOME` / `JAVA_HOME` when IntelliJ or its bundled JBR is installed at
a non-default path.

The package script writes `packages/intellij/build/distributions/paseo-intellij-0.1.2.zip`.
It replaces the web assets with the freshly built Paseo 0.15.0 assets and preserves the JCEF
bootstrap and dropdown viewport-event classes. It also compiles and tests the
`desktop_local_credential` bridge helper, then patches the existing JCEF dispatcher to call it.
The helper returns a token only when the requested TCP endpoint matches a live daemon marked as
desktop-managed in `~/.paseo/paseo.pid`; it returns no credential for other endpoints or daemons.
The package also patches the JCEF host's Content Security Policy to allow `unsafe-eval` for trusted
plugin client bundles, which Paseo evaluates dynamically in the UI. Without this directive, the
JCEF browser blocks plugin setup and contributed sidebar entries never register.

The JCEF host implementation is reused from the locally installed plugin because this checkout
does not contain the original IntelliJ host source. The UI and credential helper are built from
this checkout. The host JAR is a local build input only. Install the resulting ZIP manually from
IntelliJ's plugin settings; the packaging script does not install or modify the IDE.
