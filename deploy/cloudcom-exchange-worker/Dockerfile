# Candidate only. Refresh the reviewed base digests during planned security updates.
# Build from the repository root: docker build -f deploy/cloudcom-exchange-worker/Dockerfile .
ARG SDK_IMAGE=mcr.microsoft.com/dotnet/sdk:10.0-noble@sha256:35d40304542c8689331f8cab17c65926cdf48fe711e289321d71924b230a7d29
ARG RUNTIME_IMAGE=mcr.microsoft.com/dotnet/runtime:10.0-noble@sha256:ff17a18b639a0327e52c7c296fa2e1abe6e03eb61d8121a8ef67cc6aa430a27e
FROM ${SDK_IMAGE} AS module

ENV POWERSHELL_TELEMETRY_OPTOUT=1
RUN pwsh -NoLogo -NoProfile -NonInteractive -Command \
    '$ErrorActionPreference = "Stop"; \
     if ($PSVersionTable.PSVersion -lt [version]"7.6.0") { throw "PowerShell 7.6+ is required" }; \
     Install-Module ExchangeOnlineManagement -RequiredVersion 3.10.0 -Scope AllUsers -Force -AcceptLicense; \
     Import-Module ExchangeOnlineManagement -RequiredVersion 3.10.0 -ErrorAction Stop; \
     if (-not (Get-Command Connect-ExchangeOnline -ErrorAction SilentlyContinue)) { throw "Exchange module unavailable" }'

FROM ${RUNTIME_IMAGE}
ENV POWERSHELL_TELEMETRY_OPTOUT=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    HOME=/tmp \
    CLOUDCOM_EXCHANGE_DESCRIPTOR_FILE=/run/cloudcom-exchange-private/tenants.json \
    CLOUDCOM_EXCHANGE_SOCKET_PATH=/run/cloudcom-exchange-private/exchange.sock
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 cloudcom && useradd --uid 1001 --gid 1001 --no-create-home --shell /usr/sbin/nologin cloudcom \
    && mkdir -p /app
COPY --from=module /usr/share/powershell /usr/share/powershell
COPY --from=module /usr/local/share/powershell/Modules /usr/local/share/powershell/Modules
RUN ln -s /usr/share/powershell/pwsh /usr/local/bin/pwsh \
    && pwsh -NoLogo -NoProfile -NonInteractive -Command \
       'Import-Module ExchangeOnlineManagement -RequiredVersion 3.10.0 -ErrorAction Stop; \
        if ($PSVersionTable.PSVersion -lt [version]"7.6.0") { throw "PowerShell version mismatch" }'
COPY --chown=1001:1001 scripts/cloudcom/exchange-worker.py /app/exchange-worker.py
COPY --chown=1001:1001 scripts/cloudcom/exchange-persistent.ps1 /app/exchange-persistent.ps1
COPY --chown=1001:1001 deploy/cloudcom-exchange-worker/healthcheck.py /app/healthcheck.py
WORKDIR /app
USER 1001:1001
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD ["python3", "/app/healthcheck.py"]
ENTRYPOINT ["python3", "/app/exchange-worker.py", \
    "--socket", "/run/cloudcom-exchange-private/exchange.sock", \
    "--config", "/run/cloudcom-exchange-private/tenants.json", \
    "--script", "/app/exchange-persistent.ps1", \
    "--api-user", "cloudcom"]
