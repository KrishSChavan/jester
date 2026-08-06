v1 (ongoing):
- [x] full screen — cinema mode (window fullscreen + player pinned to viewport)
      by default, optional true fullscreen via chrome.debugger

v2:
- [x] move mouse / click — a half-open hand raises an in-page cursor, thumb-to-
      index pinch clicks. Can't move the *OS* cursor from an extension, so that
      waits for v3.
- [x] move tabs / windows — switch, reorder, open, close, reopen, cycle windows,
      plus back / forward / reload and scrolling.
- [x] a second binding set for when you're not in fullscreen, so swipes can seek
      through a film in fullscreen and flip between tabs while browsing.
- scroll with the pointer pose (bound to poses and swipes today, not yet to the
  half-open hand itself)
- [~] voice dictation for input fields / keyboard commands — a raised index
      finger opens the mic and raises the voice pill, and Chrome's speech
      recognition transcribes while it's up. The transcript only goes to the
      console so far; routing it to a field or a command is what's left.
- [x] .env build flags — CURSOR toggles the virtual cursor off and out of the
      UI entirely; AI holds the assistant key (shape-checked only, unused).


v3:
- electron pc app to control whole pc


v4:
- AI assistant LLM background (local on pc)
  - helps with small things like pulling or doing things on the pc

v5:
- connecting multiple pcs / devices to one network of this app and being able to control all of them together.