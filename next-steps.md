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
- [x] voice commands — a raised index finger opens the mic and raises the voice
      pill; drop it and the sentence goes to Groq with a digest of the page:
      where you are and a few dozen names, not the HTML. It replies with steps
      that name what they want ("click the search button") and the content
      script finds them — exact name, then part of it, then the words in it,
      then what the phrase usually means, then the markup, and if all of that
      comes up empty it hands back the nearest names to aim at instead. Then it
      looks again. The pill collapses into a spinning ball while it works and
      opens back out around the answer. Questions are answered the same way,
      with no actions.
- [x] .env build flags — CURSOR toggles the virtual cursor off and out of the
      UI entirely; AI holds the Groq key, AI_MODEL optionally pins the model.


v3:
- electron pc app to control whole pc


v4:
- AI assistant LLM background (local on pc)
  - helps with small things like pulling or doing things on the pc

v5:
- connecting multiple pcs / devices to one network of this app and being able to control all of them together.