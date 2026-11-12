# PineVision backend on Azure Container Apps

This branch adds a Linux container for the Flask backend and MediaMTX. Keep the
YOLO model and Firebase service-account JSON out of the image and Git.

## Build and publish the image

Create an Azure Container Registry in the Azure for Students subscription,
then from the repository root on this branch, run:

```powershell
az login
az acr build --registry <your-acr-name> --image pinevision-backend:latest .
```

`<your-acr-name>` is the registry's unique name (without `.azurecr.io`). The
Docker build context excludes the model, Firebase key, and Windows MediaMTX
binary. The Linux MediaMTX executable is downloaded during the image build.

## Container App configuration

- Image: `<your-acr-name>.azurecr.io/pinevision-backend:latest`
- Registry pull: managed identity with `AcrPull` on the registry
- HTTP ingress: external, target port `5000`
- Additional external TCP ingress: target port `1935`, exposed port `1935`
- Keep MediaMTX control API port `9997` private (do not add it as ingress)
- Replicas: minimum `1`, maximum `1`; detector and scan state are in process
- CPU/memory: use `2 CPU / 4 GiB` to start; increase to `4 CPU / 8 GiB` if
  inference is too slow and the student subscription permits it

The Container Apps environment must use the custom VNet already selected in
the portal because external TCP ingress requires a VNet. Configure port 1935
as an additional TCP mapping after the app is created if the creation wizard
doesn't show the additional-port controls.

## Model and uploaded-video storage

Create an Azure Files share and mount it read/write in the app at
`/mnt/pinevision`. Upload `best.pt` to the share root. Uploaded MP4s and scan
manifests are stored under `/mnt/pinevision/pinevision_uploads`.

Add these Container App environment variables:

```text
PINEVISION_DATA_DIR=/mnt/pinevision
PINEVISION_MODEL_PATH=/mnt/pinevision/best.pt
PINEVISION_RTMP_HOST=<Container App public FQDN, without https://>
PINEVISION_PUBLIC_BASE_URL=https://<Container App public FQDN>
PINEVISION_ALLOWED_ORIGINS=https://<your-vercel-domain>
PORT=5000
```

Add `FIREBASE_SERVICE_ACCOUNT_JSON` as an Azure Container App secret containing
the service-account JSON, then map the secret to an environment variable with
the same name. Never put the JSON in Git, the image, or a screenshot.

Before redeploying the frontend, set `window.PINEVISION_API_BASE` in
`frontend/js/backend-config.js` to `https://<Container App public FQDN>`.
The frontend and backend must both use HTTPS.

## Live stream URL

With the TCP mapping active, the drone/controller must publish to
`rtmp://<Container App public FQDN>:1935/pinevision_scan`. The backend proxies
the HLS preview through its HTTPS origin so Vercel browsers can play it without
mixed-content blocking. Verify the controller's network permits outbound TCP
1935 before the defense.
