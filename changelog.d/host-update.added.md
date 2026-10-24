- An npm install of connectome-host can update itself once a one-time setup
  has wrapped it: "Updating an install" in docs/DEPLOYMENTS.md says how. The
  host reads the registry at start and once a day, and says when a newer
  release is out and what the releases since cost, in its log, `/update` and
  `/healthz`'s new `update` section (`CONNECTOME_UPDATE_CHECK=0` or
  `NO_UPDATE_NOTIFIER` turns that off). `/update install` installs it beside
  the running release. `/update restart` quiesces the host and its fleet
  children, then stops it for the service's next start to switch, on trial
  until the new release has opened its stores and connected its servers,
  going back by itself if it ends before that, and `/update` then shows the
  last lines the new release kept of what it wrote. `/update back` goes back
  afterwards, keeping the newer data or restoring the copy taken at the
  switch, and `bun <root>/start.js --go-back` asks for that from a shell when
  the new release keeps exiting.
