// Checks the repository from the resource metadata for a newer release.
(() => {
  if (GetConvarInt('mysql_versioncheck', 1) === 0) return;

  const resourceName = GetCurrentResourceName();
  const currentVersion = GetResourceMetadata(resourceName, 'version', 0)?.match(/(\d+)\.(\d+)\.(\d+)/);
  const repository = GetResourceMetadata(resourceName, 'repository', 0)?.match(/github\.com\/([^/]+\/[^/.]+)/)?.[1];

  if (!currentVersion || !repository) return;

  setTimeout(async () => {
    let release: any;

    try {
      const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
        signal: AbortSignal.timeout(10000),
      });

      if (response.status !== 200) return;

      release = await response.json();
    } catch (err: any) {
      return console.warn(`Failed to retrieve latest version of ${resourceName} (${err?.cause?.code ?? err?.name}).`);
    }

    if (release.prerelease) return;

    const latestVersion = release.tag_name?.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!latestVersion || latestVersion[0] === currentVersion[0]) return;

    for (let i = 1; i < currentVersion.length; i++) {
      const current = parseInt(currentVersion[i]);
      const latest = parseInt(latestVersion[i]);

      if (current === latest) continue;
      if (current < latest)
        console.log(
          `^3An update is available for ${resourceName} (current version: ${currentVersion[0]})\r\n${release.html_url}^0`,
        );

      return;
    }
  }, 1000);
})();

export {};
