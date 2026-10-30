- `/auth status`, and the credential state the Web UI and `GET /credential`
  read, now show the credential's own expiry as it is when read, in every
  state. After a refresh the host made by itself they kept the expiry from
  when the state was entered, and a quota state showed none. Whether the
  host can refresh the credential is read the same way, so it follows a
  pasted token too, except during a pending login, which still says it
  can't.
