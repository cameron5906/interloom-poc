interface InstallCommandProps {
  networkUrl: string;
}

export function InstallCommand({ networkUrl }: InstallCommandProps) {
  const command = `curl -fsSL ${networkUrl}/install.sh | sh`;
  return (
    <>
      <code className="il-mono il-update-modal__cmd">{command}</code>
      <p className="il-settings__version-meta">
        Windows: run this inside Git Bash or WSL — PowerShell&apos;s curl is not compatible.
      </p>
    </>
  );
}
