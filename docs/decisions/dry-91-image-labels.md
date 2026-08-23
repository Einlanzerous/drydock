# The shell image says which commit it is (DRY-91)

`publish-shell.yml` stamps `org.opencontainers.image.revision` and
`.source` through `docker/build-push-action`'s `labels:`. Before this,
drydock-shell published neither, and was the one first-party image on the estate
that could not be identified by any mechanism: switchyard's delivery matrix
either asks a service over HTTP or inspects its container, and the daemon runs
on the HOST, so there is no HTTP surface inside this image to ask. The labels
are not one route among several here; they are the only one.

1. **`version` is absent on a `main` build and set on a RELEASE build, and
   filling the first from `package.json` is still the regression.** *(Amended by
   SERV-125 — originally this said `version` is absent always, because nothing
   here published a semver tag.)* Releases now publish `X.Y.Z` + `X.Y`, and the
   release build takes the version from the tag release-please just cut: the one
   moment the tag and the tree genuinely agree. Between releases there is still
   no release identity to state, and the tempting source is still `package.json`,
   still wrong for the reason that only shows up later — release-please leaves
   the LAST released version there at every commit on `main`, so every
   between-releases build would claim to be a release it isn't. An empty version
   is a legitimate row that records the revision and shows the version as unknown
   (`delivery-facts.sh` says so outright); a confident wrong one is the failure
   the matrix exists to avoid.
2. **`revision` is the load-bearing half, because digests lie and revisions
   don't** (SERV-88). Two builds of ONE commit routinely disagree on digest
   here — a job re-run, or a `workflow_dispatch` on a commit its own push
   already built, rebuilt against a `nginx:1.27-alpine` that has moved
   underneath it — so comparing digests invents drift that isn't there.
   **The estate rule's worked example now DOES transfer** — *(amended by
   SERV-125; this paragraph previously said at length that it does not, which was
   correct until the release path changed, and `41be8c7` had already corrected it
   once on the old mechanism.)* A release fires this workflow twice on the SAME
   commit: once from the push to `main`, and once called from `release-please.yml`
   in that same run. The release-please merge commit is not a different commit
   from the one the push run builds — it IS that commit. So one commit under two
   digests is now the ordinary case here, exactly as the estate rule describes.
3. **Through `labels:`, never an `ARG`/`LABEL` pair.** A build arg that changes
   every build invalidates every layer beneath it, which here is `bun install`
   and the Vite build. Labels are image config and cost no cache — measured:
   rebuilding with a different revision reported CACHED for all 12 layers.
4. **The checkout is pinned to a resolved `BUILD_REF`, and the revision is read
   back out of it.** *(Amended by SERV-125 — this was `github.sha`.)* On a push
   the two agree. They diverge on a back-publish: the run is dispatched from
   `main` with a `tag` input, so `github.sha` is main's tip and not the tag being
   built, and stamping the workflow's sha would label the image with a commit it
   does not contain. So the build ref is resolved first, checked out, and
   `git rev-parse HEAD` supplies both the `:<sha>` tag and the revision label —
   which is why they cannot disagree. A revision that can be wrong is worse than
   none.
5. **Don't test this against switchyard's `identifyContainer`.** That is tier B,
   which SKIPS first-party images by design ("tier A observes it") and returns
   `skipped` for drydock-shell however good its labels are — so reading it as
   the consumer concludes the change did nothing. The collector that reads these
   labels is construct-server's `scripts/delivery-facts.sh` (SERV-117), which
   filters FOR the `ghcr.io/einlanzerous/` prefix.
6. **A plain local `docker build` must stay label-less**, which the action route
   gives for free. Verified against the built image: with labels passed, revision
   equals HEAD; without, both fields are empty, and `nginx:1.27-alpine` carries
   no OCI labels of its own, so there is no base-image version to be inherited
   and believed.

Verify with the same command the audit used, against a freshly pulled image:

```sh
docker inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}|{{index .Config.Labels "org.opencontainers.image.revision"}}' \
  ghcr.io/einlanzerous/drydock/shell:latest
```

