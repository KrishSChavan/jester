/**
 * What Controls is made of (controls.js mounts it in a shadow root on his window's Controls screen, so its ids and
 * styles are its own): the icons, its screens (the blocks, reading a folder, the review, a scene), and what goes
 * over them (a block's ⋯ menu, a question, a folder being dropped, a word at the foot).
 */
export const VIEW = `
<!-- Icons: 24×24, drawn with a 1.8 stroke in the text's colour, as in Jester's window. -->
<svg class="sprite" aria-hidden="true" focusable="false">
  <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></symbol>
  <symbol id="i-more" viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none" /></symbol>
  <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" /></symbol>
  <symbol id="i-folder" viewBox="0 0 24 24"><path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l1.8 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" /></symbol>
  <symbol id="i-close" viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /></symbol>
  <symbol id="i-back" viewBox="0 0 24 24"><path d="M14.5 5.5L8 12l6.5 6.5" /></symbol>
  <symbol id="i-trash" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></symbol>
  <symbol id="i-tick" viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9" /></symbol>
  <symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 3.5L2.5 20h19z" /><path d="M12 10v4.5M12 17.4v.1" /></symbol>
  <symbol id="i-mic" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" /></symbol>
  <symbol id="i-edit" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" /></symbol>
  <symbol id="i-menu-bar" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M3 8.5h18M15 6.3h3" /></symbol>
  <symbol id="i-script" viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M7 10l3 2.5L7 15M12.5 15H17" /></symbol>
  <symbol id="i-bulb" viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" /></symbol>
  <symbol id="i-plug" viewBox="0 0 24 24"><path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5" /></symbol>
  <symbol id="i-fan" viewBox="0 0 24 24"><circle cx="12" cy="12" r="1.6" /><path d="M12 10.4C11 6 12.6 3.4 15 4.5s1 4.6-1.6 6.3M13.4 12.9c4.3 1.4 5.7 4 3.9 5.8s-4.3-.9-5-3.6M10.6 12.6c-3.4 3-6.3 3-6.9.4s2.6-3.9 5.3-3.2" /></symbol>
  <symbol id="i-speaker" viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2.5" /><circle cx="12" cy="14" r="3.5" /><circle cx="12" cy="7" r="1" /></symbol>
  <symbol id="i-tv" viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="12" rx="2" /><path d="M8 3l4 4 4-4M7 21h10" /></symbol>
  <symbol id="i-lock" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></symbol>
  <symbol id="i-blinds" viewBox="0 0 24 24"><path d="M4 4h16M5 4v12M19 4v12M5 8h14M5 12h14M5 16h14M12 16v4" /></symbol>
  <symbol id="i-thermostat" viewBox="0 0 24 24"><path d="M10 4a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0zM12 9v7" /></symbol>
  <symbol id="i-music" viewBox="0 0 24 24"><path d="M9 18V6l10-2v12" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="16" r="2" /></symbol>
  <symbol id="i-power" viewBox="0 0 24 24"><path d="M12 3v8M7 6.5a7 7 0 1 0 10 0" /></symbol>
  <symbol id="i-bolt" viewBox="0 0 24 24"><path d="M13 3L5 13.5h6L10 21l8-10.5h-6z" /></symbol>
  <symbol id="i-camera" viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8.5 7l1.5-3h4l1.5 3" /><circle cx="12" cy="13.5" r="3.5" /></symbol>
  <symbol id="i-desktop" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></symbol>
  <symbol id="i-sparkle" viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" /></symbol>
  <symbol id="i-home" viewBox="0 0 24 24"><path d="M4 11l8-7 8 7M6 9.5V20h12V9.5" /></symbol>
</svg>

<div id="screens">
  <!-- The blocks: scenes first, then a card for each script, then the place to add one. -->
  <section id="main" class="screen shown" aria-labelledby="title">
    <header class="top">
      <button id="leave" class="icon" type="button" aria-label="Back to Jester" title="Back to Jester"><svg class="icon-svg"><use href="#i-back" /></svg></button>
      <h1 id="title">Controls</h1>
      <button id="add" class="icon" type="button" aria-label="Add a script folder" title="Add a script folder"><svg class="icon-svg"><use href="#i-plus" /></svg></button>
    </header>
    <div id="scroll" class="scroll">
      <div id="welcome" class="welcome" hidden>
        <div class="welcome-art" aria-hidden="true"><svg class="icon-svg"><use href="#i-script" /></svg></div>
        <h2>Your scripts, one tap away</h2>
        <p>Add a folder of scripts and Jester reads it and lays out its buttons and sliders here. He can run them when you ask him, too.</p>
        <button id="welcome-choose" class="primary" type="button"><svg class="icon-svg"><use href="#i-folder" /></svg>Choose a folder…</button>
        <p id="welcome-drop" class="faint">or drop one anywhere here</p>
        <p id="welcome-mac" class="faint" hidden>Add one from Jester on your Mac: Controls there has a + to add a folder.</p>
      </div>

      <!-- His website, with the Mac the scripts are on not connected: nothing to show or run. -->
      <div id="away" class="welcome" hidden>
        <div class="welcome-art" aria-hidden="true"><svg class="icon-svg"><use href="#i-desktop" /></svg></div>
        <h2>Your scripts are on your Mac</h2>
        <p id="away-why"></p>
        <button id="away-retry" class="secondary" type="button"><svg class="icon-svg"><use href="#i-refresh" /></svg>Try again</button>
      </div>

      <section id="scenes" class="scenes" aria-labelledby="scenes-title" hidden>
        <div class="section-head">
          <h2 id="scenes-title">Scenes</h2>
          <button id="scenes-edit" class="text" type="button" aria-pressed="false">Edit</button>
          <button id="scene-new" class="icon small" type="button" aria-label="New scene" title="New scene"><svg class="icon-svg"><use href="#i-plus" /></svg></button>
        </div>
        <div id="scene-list" class="scene-list" role="list"></div>
        <p id="scenes-empty" class="faint scenes-empty" hidden>A scene runs several controls at once, like “Goodnight”: everything off. Press + to make one.</p>
      </section>

      <div id="blocks" class="blocks"></div>

      <button id="drop-card" class="drop-card" type="button" hidden>
        <svg class="icon-svg"><use href="#i-plus" /></svg>
        <span><strong>Add a script</strong><small>Drop a folder here, or choose one</small></span>
      </button>
    </div>
  </section>

  <!-- Reading a folder: a moment for a jester.json, a few seconds for a draft. -->
  <section id="reading" class="screen" aria-labelledby="reading-title" inert>
    <header class="top">
      <h1 id="reading-title">Adding a script</h1>
    </header>
    <div class="center">
      <div class="spinner" aria-hidden="true"></div>
      <p id="reading-text" class="reading-text" role="status" aria-live="polite">Reading the folder…</p>
      <p id="reading-detail" class="faint"></p>
      <button id="reading-cancel" class="secondary" type="button">Cancel</button>
    </div>
  </section>

  <!-- What a folder's block will be: checked, changed if need be, then added. -->
  <section id="review" class="screen" aria-labelledby="review-title" inert>
    <header class="top">
      <button class="icon" type="button" data-back aria-label="Cancel" title="Cancel"><svg class="icon-svg"><use href="#i-back" /></svg></button>
      <h1 id="review-title">Add a script</h1>
    </header>
    <div class="scroll">
      <p id="review-intro" class="intro"></p>
      <ul id="review-problems" class="problems" hidden></ul>
      <div class="card form">
        <label class="field">
          <span>Name</span>
          <input id="review-name" type="text" maxlength="40" autocomplete="off" spellcheck="false" />
        </label>
        <div class="field">
          <span>Icon</span>
          <div id="review-icons" class="icon-pick" role="radiogroup" aria-label="Icon"></div>
        </div>
        <p id="review-folder" class="folder-line"></p>
      </div>
      <h2 class="label">Preview</h2>
      <div id="review-preview" class="preview" aria-label="How it will look"></div>
      <h2 class="label">Controls</h2>
      <p class="hint">Rename or remove any of them. “Ask first” makes Jester check with you before he runs it when someone asks out loud; the buttons here never ask.</p>
      <ol id="review-controls" class="control-list"></ol>
      <!-- Everything else it runs, or that fills in what it runs: nothing of the folder's goes unshown. -->
      <h2 class="label" id="review-also-title" hidden>Also</h2>
      <div id="review-also" class="also" hidden></div>
    </div>
    <footer class="bottom">
      <button class="secondary" type="button" data-back>Cancel</button>
      <button id="review-save" class="primary" type="button">Add to Controls</button>
    </footer>
  </section>

  <!-- A scene: a name, and the controls it runs in order. -->
  <section id="scene" class="screen" aria-labelledby="scene-title" inert>
    <header class="top">
      <button class="icon" type="button" data-back aria-label="Cancel" title="Cancel"><svg class="icon-svg"><use href="#i-back" /></svg></button>
      <h1 id="scene-title">New scene</h1>
      <button id="scene-delete" class="icon danger" type="button" aria-label="Delete this scene" title="Delete this scene" hidden><svg class="icon-svg"><use href="#i-trash" /></svg></button>
    </header>
    <div class="scroll">
      <div class="card form">
        <label class="field">
          <span>Name</span>
          <input id="scene-name" type="text" maxlength="32" autocomplete="off" placeholder="Goodnight" />
        </label>
        <p class="faint field-note">Say its name to run it: “Jester, <span id="scene-say">goodnight</span>”.</p>
      </div>
      <h2 class="label">Steps</h2>
      <ol id="scene-steps" class="step-list"></ol>
      <button id="scene-add-step" class="add-step" type="button"><svg class="icon-svg"><use href="#i-plus" /></svg>Add a step</button>
      <label class="card switch-row">
        <span><strong>Ask first</strong><small>Check with you before running it when someone asks out loud.</small></span>
        <input id="scene-ask" type="checkbox" />
      </label>
      <p id="scene-error" class="error-line" role="alert" hidden></p>
    </div>
    <footer class="bottom">
      <button class="secondary" type="button" data-back>Cancel</button>
      <button id="scene-save" class="primary" type="button">Save scene</button>
    </footer>
  </section>
</div>

<!-- A block's ⋯ menu. -->
<div id="menu" class="menu" role="menu" hidden>
  <button type="button" role="menuitem" data-op="refresh"><svg class="icon-svg"><use href="#i-refresh" /></svg>Check what’s on</button>
  <button type="button" role="menuitemcheckbox" data-op="menu" aria-checked="true"><svg class="icon-svg"><use href="#i-menu-bar" /></svg>Show in the menu bar<svg class="icon-svg check"><use href="#i-tick" /></svg></button>
  <button type="button" role="menuitem" data-op="edit"><svg class="icon-svg"><use href="#i-edit" /></svg>Edit controls…</button>
  <button type="button" role="menuitem" data-op="reveal"><svg class="icon-svg"><use href="#i-folder" /></svg>Show in Finder</button>
  <hr />
  <button type="button" role="menuitem" data-op="remove" class="danger"><svg class="icon-svg"><use href="#i-trash" /></svg>Remove from Controls…</button>
</div>

<!-- Asked in the window: dialogs don't show in it. -->
<div id="confirm" class="confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-text" hidden>
  <div class="confirm-box">
    <p id="confirm-text"></p>
    <div class="confirm-buttons">
      <button id="confirm-no" class="secondary" type="button">Cancel</button>
      <button id="confirm-yes" class="primary danger" type="button">Remove</button>
    </div>
  </div>
</div>

<div id="drop" class="drop" aria-hidden="true" hidden>
  <div class="drop-box">
    <svg class="icon-svg"><use href="#i-folder" /></svg>
    <strong>Drop to add this folder</strong>
    <small>Jester reads it and sets up its controls</small>
  </div>
</div>

<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
`;
