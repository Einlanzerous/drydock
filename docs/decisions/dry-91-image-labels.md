# The shell image says which commit it is (DRY-91)

`publish-shell.yml` stamps `org.opencontainers.image.revision` and
`.source` through `docker/build-push-action`'s `labels:`. Before this,
drydock-shell published neither, and was the one first-party image on the estate
that could not be identified by any mechanism: switchyard's delivery matrix
either asks a service over HTTP or inspects its container, and the daemon runs
on the HOST, so there is no HTTP surface inside this image to ask. The labels
are not one route among several here; they are the only one.

1. **`version` is deliberately absent, and filling it is the regression.**
   Nothing here publishes a semver tag — `latest` + sha, sha-pinned in
   construct-server's compose (`DRYDOCK_TAG`) — so there is no release identity
   to state. The tempting source is `package.json`, and it is wrong for a reason
   that only shows up later: release-please leaves the LAST released version
   there at every commit on `main`, so every between-releases build would claim
   to be a release it isn't. An empty version is a legitimate row that records
   the digest and shows the version as unknown (`delivery-facts.sh` says so
   outright); a confident wrong one is the failure the matrix exists to avoid.
2. **`revision` is the load-bearing half, because digests lie and revisions
   don't** (SERV-88). Two builds of ONE commit routinely disagree on digest
   here — a job re-run, or a `workflow_dispatch` on a commit its own push
   already built, rebuilt against a `nginx:1.27-alpine` that has moved
   underneath it — so comparing digests invents drift that isn't there.
   **The estate rule's worked example does not transfer, and importing it is
   the mistake to avoid:** "one commit built twice, once on the push to main
   and once on the release tag" needs a tag trigger, and this workflow has only
   the push and a bare `workflow_dispatch`. The release-please merge is not a
   substitute — it is a DIFFERENT commit, and its version bump changes a copied
   layer, so that pair yields two revisions and two digests, not one commit
   under two. The conclusion carries over; the example doesn't.
3. **Through `labels:`, never an `ARG`/`LABEL` pair.** A build arg that changes
   every build invalidates every layer beneath it, which here is `bun install`
   and the Vite build. Labels are image config and cost no cache — measured:
   rebuilding with a different revision reported CACHED for all 12 layers.
4. **The checkout is pinned to `github.sha`.** On a push it already matches, but
   `workflow_dispatch` resolves `github.sha` at dispatch time and checkout would
   otherwise take the branch tip — building one commit and stamping another. A
   revision that can be wrong is worse than none.
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

