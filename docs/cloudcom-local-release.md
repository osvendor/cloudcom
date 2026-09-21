# CloudCom local image promotion

A local installation can promote the exact images exported by CloudCom Candidate Images without publishing registry tags. This is an offline distribution path, not permission to skip provenance or release-signature checks. The remote signed-release download path in scripts/prod/deploy.sh remains unchanged.

## Required evidence

1. Record the successful build run, exact fork source commit and upstream baseline. Candidate source must already have successful CloudCom CI on the default branch.
2. Verify each image archive against SHA256SUMS before loading. Verify the image-config digest recorded by the build, the OCI manifest digest, the revision label and the loaded filesystem layer identities. Docker engines with different image stores may report the config digest or OCI manifest digest as Image ID; never accept an unexplained mismatch.
3. Assemble an images-only release inventory with the complete seven-image set expected by scripts/release/release-image-manifest.mjs. Bind fork-built API/web/portal references to their exact local OCI digests. Reuse unchanged agent-binaries/executor references only from a separately verified upstream signed release inventory, and record that provenance explicitly. An images-only manifest has no native release assets and must not be advertised as an agent release.
4. Sign the inventory with a separately provisioned CloudCom Ed25519 image-release key. Keep its private key outside the repository and application environment. Verify the signature, fork repository, release version, source commit and all required image repository/digest bindings with the existing release-image verifier before Compose can start the installation.
5. Keep agent trust independent: BINARY_GITHUB_REPOSITORY and the API's agent-manifest trust root continue to use the official upstream source. The local image-release key must not silently replace the agent trust root.
6. Preserve the signed inventory, public key, archive checksums and source/build metadata with the deployment. Local references must resolve to the verified loaded images. Do not replace them with mutable tags. Preserve the archives securely because Actions artifact retention is limited.

## Clean installation

For a requested clean start, generate new application secrets and bootstrap credentials and create new database, Redis, API-data and binaries volumes. Do not import old accounts or application data. Validate an empty database initialization and the unprivileged role/RLS behavior. Test API, web and portal startup with isolated disposable resources before cutover.

Cloudflare is infrastructure, not application data. Preserve the tunnel and Access policies, the existing localhost origin endpoint, and the API's explicit CF_ACCESS settings when configured. If the container network changes, update the exact trusted proxy CIDRs to match the new Caddy and gateway addresses. Do not expose the application publicly to work around Access. Check the preview locally and verify that unauthenticated public requests still reach Cloudflare Access after cutover. Authenticated acceptance uses the ordinary protected browser flow.

Keep private topology, credentials and operational logs outside the public repository. After successful cutover, remove only the explicitly inventoried old application containers, volumes and obsolete installation paths. Never remove Cloudflare tunnel credentials/configuration or unrelated services as part of application cleanup.
