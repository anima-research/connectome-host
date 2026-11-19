- `modules.selfUpdate` gives an agent `lifecycle--update`, its own `/update`. It is off by default. Its actions:
  - `check`;
  - `notes`: the notes of the releases after the running one, up to the one installed;
  - `install`;
  - `restart`: armed for the host's first quiet moment, once nothing is in flight here or on any fleet child that it asks;
  - `cancel`.

  `restart` arms only on a headless host that started with `CONNECTOME_SUPERVISED=1` in its environment. `connectome service install` sets that only for a service that restarts the host when it exits with 75 and when it exits with 1. A service written by hand needs that line and both restarts. Anywhere else, `restart` refuses and says why.
  - **A busy host:** a host that is still busy at its quiet moment keeps the restart armed. It serves meanwhile, and tries again at least a minute later.
  - **A busy fleet child:** a fleet child counts as busy while it holds turn work that its framework doesn't count. An example is a text that the framework refused, which the child keeps for the framework that a session switch installs next. A fleet child on a release that doesn't report its work in flight is counted by its turns and scripts alone.
  - **Turns that the switch doesn't wait for:** a turn on a fleet child that started after the switch's last look asked the others, and a turn that a resume reached after that look.
  - **A child's socket:** while a restart stays armed, each try connects again to a fleet child whose socket another client took. A child's socket keeps one client. So a person connected to a child's socket loses that connection about once a minute.
  - **An operator's Restart or Go back** takes an armed restart's place.

  An armed restart lasts only while its host runs.
  - **What shows it:** `/update` shows an armed restart, and what its last try waited on. It also shows a restart that didn't go ahead, and why. `/healthz` shows the same under the `ops` scope. Without that scope, `/healthz` empties the reasons.
  - **A `cancel`:** any agent with the tool can cancel a restart, whoever armed it. A `cancel` leaves that record too, and the record names the agent that cancelled. A `cancel` also ends the switch's quiesce, and the record names any host that this end didn't reach.
  - **Who asked:** a switch that an agent armed names that agent in its mark, and in each journal line that the launcher writes from it. `check`'s line for the last switch says which agent asked for it.
