# Independent Client Releases

**Pocket Calendar** and **Pocket Notes** are two separate applications with independent versions, tags, and GitHub Releases. Client packages (standalone Web builds and Android APKs) are published directly to [GitHub Releases](https://github.com/12bitsD/pocket/releases).

## Release tags

```text
calendar-v<version>
notes-v<version>
```

Example:

```sh
git tag calendar-v0.2.0
git push origin calendar-v0.2.0
```

Pushing an app tag runs `npm test` and `npm run check`, packages that app's artifact into `dist/`, and publishes it to the corresponding GitHub Release without triggering a release for the other app.
