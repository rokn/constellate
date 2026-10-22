# Constellate

## Deploying

Pushing to `main` runs CI (`.github/workflows/ci.yml`), which builds and pushes `ghcr.io/rokn/constellate:sha-<short sha>`. That alone deploys nothing.

To deploy, bump the image in the HomeLab repo (`~/programming/HomeLab`), directly on `main`:

1. Wait for the CI run of the commit to succeed (`gh run list`), so the image exists.
2. In HomeLab, change the `image` tag in `apps/constellate/app.go` to the new `sha-<short sha>`.
3. Run `task build` to regenerate `apps/constellate/dist/*.yaml`.
4. Commit the Go change and the regenerated YAML as `constellate: image sha-<short sha> (<what changed>)` and push. ArgoCD syncs the cluster from there.
