# Constellate

## Deploying

Pushing to `main` runs CI (`.github/workflows/ci.yml`), which builds and pushes `ghcr.io/rokn/constellate:sha-<short sha>`, then its `deploy` job bumps the image in HomeLab and pushes to HomeLab's `main`. ArgoCD syncs the cluster from there. The job needs the `HOMELAB_TOKEN` secret (a fine-grained PAT with Contents read and write on `rokn/HomeLab`), and skips a commit that is no longer the head of `main`.

To deploy by hand (if the job fails), bump the image in the HomeLab repo (`~/programming/HomeLab`), directly on `main`:

1. Wait for the CI run of the commit to succeed (`gh run list`), so the image exists.
2. In HomeLab, change the `image` tag in `apps/constellate/app.go` to the new `sha-<short sha>`.
3. Run `task build` to regenerate `apps/constellate/dist/*.yaml`.
4. Commit the Go change and the regenerated YAML as `constellate: image sha-<short sha> (<what changed>)` and push. ArgoCD syncs the cluster from there.
