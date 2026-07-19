import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { useUpdater } from "./useUpdater";

const RELEASE_DOWNLOAD_URL =
  "https://github.com/kevsmir02/puhon/releases/latest";

export function UpdaterDialog() {
  const { status, isManual, install, dismiss } = useUpdater();
  const [copied, setCopied] = useState(false);
  const manualVersion =
    status.kind === "manual-available" ? status.info.version : "";
  const rpmCommand = `sudo dnf install ./puhon-${manualVersion}-1.x86_64.rpm`;

  const open =
    status.kind === "ready" ||
    status.kind === "installing" ||
    status.kind === "manual-available" ||
    (isManual && (
      status.kind === "checking" ||
      status.kind === "downloading" ||
      status.kind === "available" ||
      status.kind === "pkg-available" ||
      status.kind === "error"
    ));

  if (!open) return null;

  const downloading = status.kind === "downloading";
  const ready = status.kind === "ready";
  const installing = status.kind === "installing";
  const error = status.kind === "error";

  const activeUpdate = ready ? status.update : (downloading ? status.update : null);
  const activePkg = ready ? status.info : (downloading ? status.info : null);
  const manual = status.kind === "manual-available" ? status.info : null;

  const copyCommand = async () => {
    if (!navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(rpmCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };
  const progress =
    downloading && status.contentLength
      ? Math.min(100, (status.downloaded / status.contentLength) * 100)
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (
          !o &&
          (status.kind === "ready" ||
            status.kind === "manual-available" ||
            status.kind === "error")
        )
          dismiss();
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            {ready
              ? "Update ready"
              : downloading
                ? "Downloading update…"
                : installing
                  ? "Installing…"
                  : error
                    ? "Update failed"
                    : activePkg
                      ? `Puhon v${activePkg.version} is available`
                      : manual
                        ? `Puhon v${manual.version} is available`
                        : activeUpdate
                          ? `Puhon v${activeUpdate.version} is available`
                          : "Puhon update"}
          </DialogTitle>
          <DialogDescription>
            {ready
              ? "Restart Puhon to finish installing."
              : downloading
                ? progress !== null
                  ? `${progress.toFixed(0)}%`
                  : "Downloading…"
                : installing
                  ? "Enter your password in the system prompt."
                  : error
                    ? status.message
                    : activePkg
                      ? `You're on v${activePkg.currentVersion}. Installing will ask for your password.`
                      : manual
                        ? `You're on v${manual.currentVersion}. Grab the RPM from the release page or run the command below.`
                        : "A new version is ready to install."}
          </DialogDescription>
        </DialogHeader>

        {downloading && progress !== null && (
          <Progress value={progress} className="mt-2" />
        )}
        {downloading && progress === null && (
          <Progress value={undefined} className="mt-2 animate-pulse" />
        )}

        {activePkg && ready && (
          <p className="mt-2 text-sm text-muted-foreground">
            Puhon v{activePkg.version} is available (you are on v{activePkg.currentVersion}
            ). Installing will ask for your password.
          </p>
        )}

        {installing && (
          <p className="mt-2 text-sm text-muted-foreground">
            Installing... enter your password in the system prompt.
          </p>
        )}

        {manual && (
          <div className="mt-2 flex flex-col gap-2">
            <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 font-mono text-[12px]">
              <span className="flex-1 select-all">$ {rpmCommand}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => void copyCommand()}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          {error && (
            <Button size="sm" onClick={dismiss}>
              Close
            </Button>
          )}
          {ready && (
            <>
              <Button variant="ghost" size="sm" onClick={dismiss}>
                Later
              </Button>
              <Button size="sm" onClick={() => void install()}>
                {activeUpdate ? "Install & restart" : "Install update"}
              </Button>
            </>
          )}
          {manual && (
            <>
              <Button variant="ghost" size="sm" onClick={dismiss}>
                Later
              </Button>
              <Button
                size="sm"
                onClick={() => void openUrl(RELEASE_DOWNLOAD_URL)}
              >
                Download RPM
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

