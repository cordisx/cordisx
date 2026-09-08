# Build an SDK from an exact Host commit

Use Node 22.19 or newer, npm, Git, and tar. From a checkout of the desired
Host commit, run:

```sh
node scripts/prepare-sdk.mjs /absolute/path/to/new-sdk-build
```

The output directory must not exist. The builder archives `HEAD`; uncommitted
edits and an existing `node_modules` are never build inputs. It fetches every
Git dependency at the full commit in `package-lock.json`, materializes source
tarballs without lifecycle scripts, and runs `npm ci --ignore-scripts` against
a disposable lockfile with those local source references. Registry versions
and integrity hashes remain locked. No recursive Git `prepare` installation
is needed. Network access to GitHub and the configured npm registry is required.

The builder restores the canonical manifests and lockfile, compiles the Host,
and builds the pinned Channel and CLIProxy plugins against that public Host SDK
using its installed build tools. It checks package exports, runtime manifest
digests, and service entry files before packing. This is a Host compatibility
build of unchanged plugin source, not a claim that each plugin's independent
development lockfile was installed.

The `packages` directory contains the CLI, creator, Protocol, Channel, and
CLIProxy tarballs. The CLI bundles complete Channel and CLIProxy runtimes plus Schemastery UI;
The CLI declares their exact bundled versions; `cordisxSources` in its manifest
and `cordisxSource` in each bundled plugin retain canonical Git commit refs.
The root build manifest continues to pin the Git dependencies. This avoids npm
marking bundled Git edges invalid when its lockfile omits their resolved URLs.
Protocol remains a shared dependency because its unique-symbol types must have
one module identity across Host and consumer imports. Protocol has no prepare
hook. Consumers can install the CLI without rebuilding the Git plugins. When
using the generated Protocol tarball directly, consumers must apply one npm
override for that same package throughout the dependency graph.
`sdk-evidence.json` records the Host commit, all Git inputs, Node/npm versions,
and SHA-256 and SHA-512 hashes. The retained `host` directory can run the normal
Host validation gates. Bootstrap tarballs are incomplete build inputs and must
never be distributed as plugin artifacts.

CLI and creator builds normalize executable entry permissions to `0755`, so a
previous npm bin link cannot change subsequent tarball bytes. Reproducibility
should be checked by comparing output hashes from independent clean builds
with the same Node/npm versions; a successful packaging command alone is not a
passing full Host check or native application smoke test.
