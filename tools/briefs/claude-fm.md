# Brief: Claude FM as the default car radio (owner request, Nov 23)

Owner: "the default radio should be the stream from Anthropic's live Claude music on YouTube."
That is Claude FM, Anthropic's 24/7 live music stream on YouTube (channel @claude; a watch URL seen in
the press was youtube.com/watch?v=YmQ7jRgf4f0, but the stream restarts and changes its video id, so do
not hard-code a video id: find the channel id and embed `https://www.youtube.com/embed/live_stream?
channel=<id>`, and confirm in real Chrome on the laptop that it plays and that embedding is allowed).

What the owner wants: Claude FM is the first station on the car radio and the one that comes on by
default; the six generated stations (src/audio/, `STATIONS`) stay on the dial after it; T and the
RADIO touch key step through them as now; the radio volume slider controls it.

Rules that shape it:
- OWNER DECISION (Nov 23): the YouTube player is HIDDEN, for the purposes of the demo. The owner was told
  this goes against YouTube's terms for embedded players and chose it anyway. Keep the iframe in the page
  but invisible (for example 200x200, opacity 0, pointer-events none, behind the canvas; not display:none,
  which can stop playback), and check in real Chrome that the sound keeps playing while hidden, including
  in a background-throttled state. Show only a text label on the HUD's radio readout ("Claude FM").
  Use the YouTube IFrame Player API (loaded from youtube.com, the one network call allowed for this; not a
  bundled dependency) for play, pause, volume and errors.
- It plays only after the player's first click or tap (browsers require it); pause it when the game
  pauses, when the tab is hidden, and when the player leaves the car (as the generated radio does).
- If YouTube cannot be reached, embedding is refused, or it errors, fall back silently to the first
  generated station and show a short notice; never block the game.
- Multiplayer: each player's radio is their own; nothing goes on the wire.
- Load nothing from YouTube until the player first tunes to Claude FM (keep start-up fast).
- Credit it on the radio screen as "Claude FM" with a link-free label; no other branding.
Check: real headed Chrome on the laptop, driving with it on; phone layout; offline fallback
(block youtube.com in the test); tsc clean and boots with no errors.
