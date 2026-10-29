- Retrieval: a tune-out's release now opens a turn (#517). Before, it opened
  none, like every row marked `system`: agent-framework writes it into the
  residents' window as one (`kind: 'tune-out-cancel'`), so when no note from
  the subconscious followed it, the primary's turn it wakes could reuse the
  previous turn's block with no retrieval for what it released. Now
  retrieval runs for that turn, and a block it finds is headed with the
  start of the release row. That can cost a retrieval call the turn didn't
  make before (two when more than three lessons are candidates), a release
  that held nothing included. A note that follows a release is newer, and
  opens the turn as before.
