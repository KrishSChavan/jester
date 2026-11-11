/**
 * How well Jester finds things in an Obsidian vault (src/main/vault-index.js):
 * questions a user might say out loud, each with the notes that answer it, and
 * some the vault can't answer, which should bring back nothing. Each is asked
 * by words alone (BM25), by meaning alone (nomic-embed-text) and both fused, as
 * Jester asks, and scored by where the first right note comes: hit@1, hit@3, MRR.
 *
 *   node desktop/scripts/vault-eval.mjs --make <folder>     writes the sample vault into a new, empty folder
 *   node desktop/scripts/vault-eval.mjs <vault>             asks it the sample questions (made for the sample vault)
 *   node desktop/scripts/vault-eval.mjs <vault> --held-out  asks it 21 more, never tuned on
 *   node desktop/scripts/vault-eval.mjs <vault> --questions <file.json> [--today 2026-11-10]
 *        {"today": "2026-11-10", "questions": [{"q": "who’s my roommate", "want": ["People/Dev Patel.md"]}, {"q": "…", "want": []}]}
 *   --sweep     tries other floors, word shares and nudges too
 *   --verbose   every question's top three, not only the misses
 *
 * Needs Ollama running, with nomic-embed-text. The vault is only read: the
 * index is kept in a temporary folder, deleted after.
 *
 * Measured 2026-11-10 on the sample vault: 40 notes (About me, eight days of
 * conversations, four remembered, four in Notes, 23 of the user's own) in 74
 * pieces. Notes ranked, the first right one counted; "no answer, yet found" is
 * how many questions the vault can't answer still brought something back.
 *
 *   43 questions with an answer, 13 without    hit@1   hit@3   MRR    no answer, yet found
 *   words only (BM25)                          0.67    0.81    0.75
 *   meaning only (nomic-embed-text)            0.81    0.93    0.88   5 of 13 above the floor
 *   hybrid, as Jester searches                 0.93    0.93    0.93   6 of 13
 *   hybrid with Ollama off                     0.77    0.88    0.83   8 of 13
 *
 *   held out: 17 with an answer, 4 without
 *   words only / meaning only                  0.82 / 0.94 hit@1, MRR 0.86 / 0.97
 *   hybrid, as Jester searches                 0.94    1.00    0.97   1 of 4
 *   hybrid with Ollama off                     0.76    0.88    0.82   2 of 4
 *
 * A right answer's best piece scores 0.51–0.78 and a question with no answer's
 * best 0.54–0.69, so no floor parts them. At 0.6, 40 of 43 right answers are in
 * reach and chit-chat (0.54–0.58, "tell me a joke" 0.57) finds nothing, even
 * when it names a day with notes; 0.62 loses answers and no false finds; 0.64
 * halves the false finds (3 of 13) for 0.05 of MRR. A false find is a near miss
 * (Mom's note for "what's my sister's name"), and the model is told to say it
 * doesn't know when the notes don't hold the answer. Meaning alone has no
 * floor, so it ranks something for every question; the hybrid finds no right
 * note for the three whose answer scores under 0.6 ("what did I want from the
 * store": 0.51). With Ollama off, words find something for three of the five
 * chit-chat questions that name a day ("is it going to rain on Friday":
 * Friday's notes). The nudges plateau: titleBonus 0.005–0.02 with dayBonus
 * 0.01–0.03 all give MRR 0.93; with no day nudge, 0.85–0.86. Labelling pieces
 * with their folder took meaning alone from MRR 0.84 to 0.88.
 *
 * A piece is cut to fit what the model is given of it, 420 characters with
 * what it is (vault-memory.js): a section over 360 characters goes in parts of
 * 120 to 320. Cut at 1,200 at first, in parts of 400 to 1,000 (70 pieces here),
 * the table was the same but for words: 0.76 alone and 0.84 with Ollama off.
 * The sweep picks the same floor, shares and nudges at either. But the model
 * never saw a long piece's later lines: with a week's class schedule and four
 * notes that keep their facts in properties added to this vault (properties
 * read), the answer reached it for 23 of 30 questions cut at 1,200, 28 at 450,
 * and 29 at 400 down to 280 (the one left is the Apartment note's, which isn't
 * found at all). At 320, words alone fell to MRR 0.73, and at 280 the hybrid to
 * 0.91.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVaultIndex, TUNING } from '../src/main/vault-index.js';

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const SAMPLE_TODAY = '2026-11-10';

const conversations = (date, sections) => {
  const day = new Date(`${date}T12:00:00`);
  const long = day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const all = (key) => [...new Set(sections.flatMap((section) => section[key]))];
  const list = (key) => (all(key).length ? `\n${all(key).map((item) => `  - ${item}`).join('\n')}` : ' []');
  return `---
type: conversations
date: ${date}
tags:
  - jester/conversation
topics:${list('topics')}
people:${list('people')}
---
# Conversations on ${long}
${sections.map(({ time, title, summary, topics, people }) => `\n## ${time} · ${title}\nSummary: ${summary}\nTopics: ${topics.join(', ')}\nPeople: ${people.join(', ') || 'none'}\n`).join('')}`;
};
const said = (time, title, summary, topics, people = []) => ({ time, title, summary, topics, people });

const remembered = (created, title, words, topics) => {
  const at = new Date(created);
  const when = `${at.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} at ${at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  return `---
type: remembered
created: ${created}
tags:
  - jester/remembered
topics:
${topics.map((topic) => `  - ${topic}`).join('\n')}
---
# ${title}

> ${words}

Said to Jester on ${when}.
`;
};

const note = (created, updated, title, lines) => `---
type: note
tags:
  - note
created: ${created}
updated: ${updated}
---
# ${title}

${lines.map((line) => `- ${line}`).join('\n')}
`;

/** A student's vault, as Jester would find it a week in: Jester's notes and the user's own. */
const SAMPLE = {
  'Welcome.md': `This is your new *vault*.

Make a note of something, [[create a link]], or try [the Importer](https://help.obsidian.md/Plugins/Importer)!

When you're ready, delete this note and make the vault your own.
`,
  'Jester/About me.md': `---
type: profile
tags:
  - jester/profile
aliases:
  - About me
  - What Jester knows about me
updated: 2026-11-10
---
# About me

What Jester has learned about you from your conversations. Edit or delete anything here: Jester reads this note as it is.

## Who you are
- Name is Krish <!-- noted 2026-11-03 -->
- Lives in an apartment on Beaver Avenue in State College <!-- noted 2026-11-03 -->
- Grew up in Edison, New Jersey <!-- noted 2026-11-06 -->

## School and work
- Computer science major at Penn State, class of 2028 <!-- noted 2026-11-03 -->
- Taking CMPSC 465, MATH 230, STAT 318 and PHIL 103 this fall <!-- noted 2026-11-03 -->
- Works at the HUB tech help desk on Tuesday and Thursday evenings <!-- noted 2026-11-05 -->

## People
- Roommate is Dev Patel <!-- noted 2026-11-04 -->
- Mom is Priya; calls her on Sunday mornings <!-- noted 2026-11-08 -->
- STAT 318 lab partner is Maya Chen <!-- noted 2026-11-03 -->
- Best friend Arjun studies at Rutgers <!-- noted 2026-11-05 -->

## Preferences
- Vegetarian <!-- noted 2026-11-04 -->
- Studies to lo-fi playlists on Spotify <!-- noted 2026-11-03 -->
- Likes an oat milk latte from Webster's in the morning <!-- noted 2026-11-07 -->

## Plans and dates
- Flying home for Thanksgiving on November 25 <!-- noted 2026-11-06 -->
- HackPSU is November 21–22 <!-- noted 2026-11-05 -->

## Other
- Drives a silver 2015 Honda Civic <!-- noted 2026-11-09 -->
`,
  'Jester/Conversations/2026/2026-11-03.md': conversations('2026-11-03', [
    said('9:12 AM', 'Lo-fi for studying', 'The user asked Jester to play a lo-fi study playlist on Spotify before starting MATH 230 homework.', ['music', 'spotify']),
    said('4:40 PM', 'What’s due in MATH 230', 'Jester opened Canvas: MATH 230 has WebWork set 9 due Thursday night and a quiz in recitation on Wednesday.', ['math 230', 'canvas', 'homework'])
  ]),
  'Jester/Conversations/2026/2026-11-04.md': conversations('2026-11-04', [
    said('7:55 PM', 'Dinner plans with Dev', 'The user and Dev planned to cook paneer butter masala on Saturday; the user still needs heavy cream and kasuri methi.', ['cooking', 'groceries'], ['Dev Patel'])
  ]),
  'Jester/Conversations/2026/2026-11-05.md': conversations('2026-11-05', [
    said('2:15 PM', 'Dentist appointment', 'The user booked a cleaning with Dr. Alvarez and asked Jester to remember the time.', ['dentist', 'health'], ['Dr. Alvarez']),
    said('10:30 PM', 'HackPSU team', 'The user is teaming up with Dev and Arjun for HackPSU and wants to build a CATA bus arrival display.', ['hackpsu', 'projects'], ['Dev Patel', 'Arjun'])
  ]),
  'Jester/Conversations/2026/2026-11-06.md': conversations('2026-11-06', [
    said('11:20 AM', 'Thanksgiving flight', 'The user compared flights home and chose the 6:05 AM United flight from State College to Newark on November 25.', ['thanksgiving', 'travel']),
    said('6:45 PM', 'Parking at the East Deck', 'The user parked at the East Deck for the volleyball game and asked Jester to remember the spot.', ['parking', 'car'])
  ]),
  'Jester/Conversations/2026/2026-11-07.md': conversations('2026-11-07', [
    said('1:30 PM', 'Errands', 'The user asked Jester to add laundry detergent and paper towels to the grocery list before going to Wegmans.', ['groceries', 'errands']),
    said('9:10 PM', 'Movie night', 'The user and Dev decided to watch Dune: Part Two next weekend, and Jester added it to the movies list.', ['movies'], ['Dev Patel'])
  ]),
  'Jester/Conversations/2026/2026-11-08.md': conversations('2026-11-08', [
    said('11:05 AM', 'Call with Mom', 'The user talked about the call with Mom: her knee surgery is on December 1, and she wants the user home by November 25.', ['family', 'health'], ['Mom']),
    said('7:15 PM', 'Library book', 'The user asked Jester to remember when the library book is due.', ['library', 'books'])
  ]),
  'Jester/Conversations/2026/2026-11-09.md': conversations('2026-11-09', [
    said('10:05 AM', 'Algorithms midterm prep', 'The user made a study plan for the CMPSC 465 midterm: dynamic programming on Tuesday, greedy algorithms on Wednesday, graphs and shortest paths on Thursday.', ['cmpsc 465', 'midterm', 'studying']),
    said('5:30 PM', 'Oil change', 'The user said the Civic is due for an oil change and planned to book Jiffy Lube on North Atherton for Saturday morning.', ['car', 'maintenance'])
  ]),
  'Jester/Conversations/2026/2026-11-10.md': conversations('2026-11-10', [
    said('9:40 AM', 'Opening PSU Canvas', 'The user asked Jester to open their PSU Canvas bookmark in Chrome.', ['canvas', 'school']),
    said('1:05 PM', 'Locker combination', 'The user told Jester their gym locker combination and asked Jester to remember it word for word.', ['locker', 'gym'])
  ]),
  'Jester/Remembered/2026-11-05 Dentist appointment.md': remembered('2026-11-05T14:15:00-05:00', 'Dentist appointment', 'my dentist appointment is December 3rd at 2:30 with Dr. Alvarez on College Avenue', ['dentist']),
  'Jester/Remembered/2026-11-06 Parking spot.md': remembered('2026-11-06T18:45:00-05:00', 'Parking spot', 'I parked on level 3 of the East Deck, spot 42, next to the stairs', ['parking']),
  'Jester/Remembered/2026-11-08 Library book.md': remembered('2026-11-08T19:15:00-05:00', 'Library book', 'the library book is Introduction to Algorithms and it’s due back at Pattee on November 20', ['library']),
  'Jester/Remembered/2026-11-10 Locker combination.md': remembered('2026-11-10T13:05:00-05:00', 'Locker combination', 'my locker combination is 12-34-56', ['locker']),
  'Jester/Routines.md': `---
type: routines
tags:
  - jester/system
---
# Routines

What Jester does straight away, with no AI model.

## Shortcuts
- “open my canvas”: open my PSU Canvas bookmark in Chrome
- “study music”: play lo-fi beats on Spotify
`,
  'Jester/How Jester uses this vault.md': `---
type: readme
tags:
  - jester/system
---
# How Jester uses this vault

Jester reads every note in this vault and writes only in Jester and Notes. Conversations are kept as summaries and facts; your exact words only when you ask Jester to remember something.
`,
  'Notes/Grocery list.md': note('2026-10-28T18:20:00-04:00', '2026-11-07T13:30:00-05:00', 'Grocery list', ['eggs', 'oat milk', 'spinach', 'basmati rice', 'paneer', 'heavy cream', 'kasuri methi', 'laundry detergent', 'paper towels']),
  'Notes/Movies to watch.md': note('2026-10-30T22:10:00-04:00', '2026-11-07T21:10:00-05:00', 'Movies to watch', ['Dune: Part Two (with Dev, next weekend)', 'Past Lives', 'Interstellar, if it comes back to IMAX', 'The Social Network']),
  'Notes/Gift ideas.md': note('2026-11-01T16:00:00-04:00', '2026-11-08T11:30:00-05:00', 'Gift ideas', [
    'Dev’s birthday is December 2: a mechanical keyboard (he likes brown switches) or Celtics tickets',
    'Mom: a heated knee wrap for after her surgery, and a framed photo from Diwali',
    'Arjun: a board game, maybe Catan Seafarers'
  ]),
  'Notes/Packing list for Thanksgiving.md': note('2026-11-06T11:40:00-05:00', '2026-11-06T11:40:00-05:00', 'Packing list for Thanksgiving', ['laptop and charger', 'CMPSC 465 notes for the final', 'winter jacket', 'Mom’s gift', 'headphones and phone charger']),
  'School/CMPSC 465.md': `---
tags:
  - school
  - cmpsc465
aliases:
  - Algorithms
  - Data Structures and Algorithms
---
# CMPSC 465 — Data Structures and Algorithms

Fall 2026, MWF 10:10–11:00 AM, 100 Thomas Building. Canvas has the slides and Gradescope has the problem sets.

## Course info
- Instructor: Prof. Elena Marsh, W358 Westgate
- Office hours: Tuesday 2–4 PM and Thursday 11 AM–noon, or email for an appointment
- TA: Kevin Liu, Monday 6–8 PM in the Westgate CS lounge
- Grading: problem sets 30%, two midterms 40%, final 30%

## Exams
- Midterm 1: done, got an 84
- Midterm 2: Friday, November 13, 10:10 AM, in class. Dynamic programming, greedy algorithms, and graphs through shortest paths. One page of notes allowed
- Final: Tuesday, December 15, 8:00 AM, room TBA

## Homework
- Problem set 5 (dynamic programming): due Wednesday, November 11 at 11:59 PM on Gradescope
- Problem set 6 (network flow) comes out November 16
`,
  'School/CMPSC 465 Lecture 18 - Dynamic programming.md': `---
tags:
  - school
  - cmpsc465
  - lecture
---
# Lecture 18: Dynamic programming

## The idea
Dynamic programming solves a problem by breaking it into overlapping subproblems and solving each one only once. It works when the problem has optimal substructure: the best answer is built out of best answers to smaller versions of the same problem.

Memoization is the top-down way: write the obvious recursive solution, then keep a table (a dictionary or an array) of answers already computed, and check it before recursing. The recursion tree collapses into one call per distinct subproblem.

Tabulation is the bottom-up way: find an order in which every subproblem depends only on ones already solved, and fill the table in that order with loops. Usually faster in practice, and easier to save memory with, because only the last row or two need keeping.

Running time is the number of subproblems times the work per subproblem. For Fibonacci that's n times O(1); for longest common subsequence n·m times O(1); for knapsack n·W times O(1), which is pseudo-polynomial because W is a number, not a length.

Marsh's checklist: define the subproblem in words, write the recurrence, the base cases, the order to fill the table, where the answer is, and the running time.

## Examples
### Longest common subsequence
L[i][j] = L[i-1][j-1] + 1 if x_i = y_j, else max(L[i-1][j], L[i][j-1]). The answer is L[n][m].

### 0/1 knapsack
K[i][w] = max(K[i-1][w], v_i + K[i-1][w - w_i]) when w_i ≤ w.

### Edit distance
E[i][j] = min(E[i-1][j] + 1, E[i][j-1] + 1, E[i-1][j-1] + (x_i ≠ y_j)).

## For the midterm
Know how to go from a recurrence to an order to fill the table in, and practise writing the subproblem in one sentence. Problem set 5, questions 2 and 4, are the most like exam questions.
`,
  'School/MATH 230.md': `---
tags:
  - school
aliases:
  - Calc 3
---
# MATH 230 — Calculus and Vector Analysis

- Lecture: Tuesday and Thursday 1:35–2:50 PM, 102 Forum
- Recitation: Wednesday 3:35 PM with Sam Okafor
- WebWork sets due Thursdays at 11:59 PM
- Exam 3 (double and triple integrals, change of variables): Monday, November 16, 6:30 PM, 100 Thomas
- Final exam: Monday, December 14

## Tips
- Practice exams go up on Canvas the week before
- Bring a TI-84 to exams
`,
  'School/STAT 318.md': `---
tags:
  - school
---
# STAT 318 — Elementary Probability

- Lab partner: [[Maya Chen]]
- Lab: Friday 12:20 PM, 211 Thomas
- Project 2: simulate the birthday problem. Maya writes the code, I write it up. Due November 19
- A quiz every Monday on the week before
`,
  'School/PHIL 103.md': `---
tags:
  - school
---
# PHIL 103 — Introduction to Ethics

## Essay 2
1500 words: is lying ever morally permissible? Compare Kant’s categorical imperative with Mill’s utilitarianism, and take a side. Due November 18 on Canvas.

## Reading
- Mill, Utilitarianism, chapter 2
- Kant, Groundwork, section 2

Discussion section with Jordan on Thursdays at 4:40 PM.
`,
  'School/Spring 2027 schedule planning.md': `# Spring 2027 schedule planning

- CMPSC 473 (Operating Systems): required
- CMPSC 461 (Programming Language Concepts)
- STAT 414, maybe
- Registration opens November 17 at 6 AM on LionPATH
- No classes before 10 AM if I can help it
`,
  'Projects/Project ideas.md': `---
tags:
  - projects
---
# Project ideas

## Spotify mood DJ
Pick a playlist from how the day's going: calendar, weather, time of day. Spotify Web API.

## Dining hall menu bot
Text me what's good at Redifer each morning. Scrape the menu page.

## CATA bus display
Big countdown of the next CV and RP buses at my stop, on a cheap e-ink screen. The HackPSU idea.

## Flashcards from lecture notes
Turn my Obsidian class notes into Anki cards automatically.
`,
  'Projects/HackPSU 2026.md': `---
tags:
  - projects
  - hackathon
---
# HackPSU 2026

- When: November 21–22, ECore building
- Team: me, [[Dev Patel|Dev]], Arjun (driving up from Rutgers)
- Building: the CATA bus arrival display from [[Project ideas]]
- Need: a Raspberry Pi, a Waveshare e-ink screen, the CATA GTFS realtime feed
- Check-in opens 9 AM Saturday
`,
  'People/Dev Patel.md': `---
tags:
  - people
aliases:
  - Dev
---
# Dev Patel

- Roommate since sophomore year
- Birthday: December 2
- Phone: 814-555-0142
- Mechanical engineering major
- Huge Celtics fan; plays intramural basketball on Wednesdays
`,
  'People/Maya Chen.md': `---
tags:
  - people
---
# Maya Chen

- STAT 318 lab partner
- Actuarial science major
- Usually free after 3 PM; likes to meet at Pattee library
`,
  'People/Mom.md': `---
tags:
  - people
  - family
aliases:
  - Priya
---
# Mom

- Lives in Edison, NJ
- Knee surgery on December 1 at JFK Medical Center
- Loves masala chai and her garden
- I call her every Sunday morning
`,
  'Trips/Thanksgiving trip home.md': `---
tags:
  - travel
---
# Thanksgiving trip home

- Flight there: United UA 4521, State College (SCE) to Newark (EWR), Wednesday, November 25, 6:05 AM
- Flight back: Sunday, November 29, EWR to SCE, 7:40 PM
- Confirmation number is in the United app
- Dad picks me up at Newark arrivals
- Dev drives me to the airport; the car stays at the apartment
`,
  'Trips/Spring break ideas.md': `---
tags:
  - travel
---
# Spring break ideas

- Miami with Arjun and the Rutgers group: cheapest flights out of Philadelphia
- Or a road trip to the Smokies, a cabin near Gatlinburg
- Spring break is March 8–12
- Budget about $600
`,
  'Recipes/Paneer butter masala.md': `---
tags:
  - recipe
---
# Paneer butter masala

Serves 3, about 45 minutes. Dev's favourite.

## Ingredients
- 250 g paneer, cubed
- 2 tbsp butter and 1 tbsp oil
- 1 onion, 3 tomatoes, 10 cashews
- 1 tbsp ginger garlic paste
- garam masala, Kashmiri chili powder, kasuri methi
- 1/2 cup heavy cream

## Steps
1. Cook the onion, tomatoes and cashews until soft, then blend smooth.
2. Melt the butter, fry the ginger garlic paste, then the spices.
3. Add the purée and simmer 10 minutes; stir in the cream and crushed kasuri methi.
4. Add the paneer last and give it 5 minutes. Serve with basmati rice or naan.
`,
  'Recipes/Overnight oats.md': `---
tags:
  - recipe
---
# Overnight oats

For class days. Mix in a jar the evening before and leave it in the fridge.

- 1/2 cup rolled oats
- 1/2 cup oat milk and 1/4 cup Greek yogurt
- 1 tbsp chia seeds and a spoon of honey
- Banana or berries on top in the morning
`,
  'Health/Gym routine.md': `# Gym routine

At the White Building; my locker's in the downstairs locker room.

## Push (Monday)
- Bench press 4×8, overhead press 3×10, dips, triceps pushdowns

## Pull (Wednesday)
- Pull-ups, barbell rows, face pulls, curls

## Legs (Friday)
- Squats 4×6, Romanian deadlifts 3×8, walking lunges, calf raises
`,
  'Money/November budget.md': `---
tags:
  - money
---
# November budget

- Rent: $725, due on the 1st
- Groceries: $250
- Eating out: $120
- Gas: $60
- Spotify (student) $5.99, iCloud $2.99
- Thanksgiving flight: $189, paid

Whatever's left goes to savings.
`,
  'Work/HUB help desk.md': `---
tags:
  - work
---
# HUB help desk

- Shifts: Tuesday and Thursday, 5–9 PM
- Supervisor: Tanya Brooks
- Pay: $13.50 an hour; timesheet due every other Friday in Workday
- Most tickets: eduroam setup, printing with LionPrint, Duo resets
`,
  'Home/Apartment.md': `---
tags:
  - home
---
# Apartment

- 220 Beaver Ave, apartment 4B
- Landlord: Mr. Hoffman at Nittany Property Management, 814-555-0198. Call him for repairs: heater, plumbing, appliances
- Rent is due on the 1st, paid through the AppFolio portal
- Lease ends July 31, 2027
- Internet: Xfinity; the router is in the living room
- Trash goes out Wednesday night
`,
  'Car/Honda Civic.md': `---
tags:
  - car
---
# Honda Civic

- 2015 Civic LX, silver
- Oil change every 5,000 miles. Last one at 82,000 in June; next around 87,000
- Tires: 32 psi
- Registration renews in March
- Insurance with GEICO
`,
  'Reading/Books to read.md': `# Books to read

- Project Hail Mary, Andy Weir
- Thinking, Fast and Slow, Daniel Kahneman
- The Pragmatic Programmer
- Atomic Habits (halfway through)
`,
  'Inbox/Random thoughts.md': `# Random thoughts

- Ask Prof. Marsh about undergrad research in the theory group
- Try the new ramen place on Allen Street
- Need a new phone case
- Look up the Google STEP internship deadline
`,
  // Obsidian's own folder and its bin: never searched.
  '.obsidian/app.json': '{}\n',
  '.trash/Old grocery list.md': '# Old grocery list\n\n- eggs\n- whole milk\n- bread\n'
};
// The Index lists every note, so it would match anything: a good test that Jester's views are left out.
SAMPLE['Jester/Index.md'] = `---
type: index
tags:
  - jester/system
---
# Index
${Object.keys(SAMPLE)
  .filter((rel) => rel.endsWith('.md') && !rel.startsWith('.'))
  .map((rel) => `- [[${rel.replace(/\.md$/, '')}|${path.posix.basename(rel, '.md')}]]`)
  .join('\n')}
`;

const ABOUT = 'Jester/About me.md';
const day = (date) => `Jester/Conversations/2026/${date}.md`;
const kept = (name) => `Jester/Remembered/${name}.md`;
const CMPSC = 'School/CMPSC 465.md';
const LECTURE = 'School/CMPSC 465 Lecture 18 - Dynamic programming.md';

/** Asked of the sample vault on Tuesday, November 10, 2026, in the afternoon. */
const SAMPLE_QUESTIONS = [
  ['when’s my algorithms midterm', [CMPSC]],
  ['what did I want from the store', ['Notes/Grocery list.md']],
  ['who’s my roommate', [ABOUT, 'People/Dev Patel.md']],
  ['what did we talk about yesterday', [day('2026-11-09')]],
  ['what’s my locker combo', [kept('2026-11-10 Locker combination')]],
  ['where did I leave the car', [kept('2026-11-06 Parking spot'), day('2026-11-06')]],
  ['when do I fly home', ['Trips/Thanksgiving trip home.md', ABOUT, day('2026-11-06')]],
  ['what goes in that paneer curry', ['Recipes/Paneer butter masala.md']],
  ['when can I go see my algorithms professor', [CMPSC]],
  ['when is the dynamic programming homework due', [CMPSC]],
  ['what’s my mom’s name', [ABOUT, 'People/Mom.md']],
  ['what app ideas have I had', ['Projects/Project ideas.md']],
  ['what are we building at the hackathon', ['Projects/HackPSU 2026.md', day('2026-11-05')]],
  ['how much can I spend eating out this month', ['Money/November budget.md']],
  ['when does my car need its next oil change', ['Car/Honda Civic.md', day('2026-11-09')]],
  ['who’s my partner in the stats lab', [ABOUT, 'School/STAT 318.md', 'People/Maya Chen.md']],
  ['what do I do on leg day', ['Health/Gym routine.md']],
  ['what are my hours at work', ['Work/HUB help desk.md', ABOUT]],
  ['who do I call if the heat stops working', ['Home/Apartment.md']],
  ['what was I planning to read', ['Reading/Books to read.md']],
  ['remind me how memoization works', [LECTURE]],
  ['do I eat meat', [ABOUT]],
  ['what films did I want to watch', ['Notes/Movies to watch.md']],
  ['what do I need to bring when I go home', ['Notes/Packing list for Thanksgiving.md']],
  ['what did we talk about on Friday', [day('2026-11-06')]],
  ['when do I have to return the library book', [kept('2026-11-08 Library book'), day('2026-11-08')]],
  ['when’s my calc exam', ['School/MATH 230.md']],
  ['what’s my ethics paper supposed to be about', ['School/PHIL 103.md']],
  ['what should I get Dev for his birthday', ['Notes/Gift ideas.md', 'People/Dev Patel.md']],
  ['when’s rent due', ['Home/Apartment.md', 'Money/November budget.md']],
  ['where might I go for spring break', ['Trips/Spring break ideas.md']],
  ['what’s an easy breakfast I can make the night before', ['Recipes/Overnight oats.md']],
  ['when am I seeing the dentist', [kept('2026-11-05 Dentist appointment'), day('2026-11-05')]],
  ['what did we talk about this morning', [day('2026-11-10')]],
  ['what was my plan for studying for the midterm', [day('2026-11-09'), LECTURE]],
  ['isn’t mom having surgery soon', ['People/Mom.md', day('2026-11-08')]],
  ['what’s Dev’s phone number', ['People/Dev Patel.md']],
  ['when does registration open for next semester', ['School/Spring 2027 schedule planning.md']],
  ['what classes am I taking', [ABOUT]],
  ['what was that ramen place I wanted to try', ['Inbox/Random thoughts.md']],
  ['what was yesterday’s conversation about', [day('2026-11-09')]],
  ['recap today’s conversations', [day('2026-11-10')]],
  // A day named, but asked about something on it.
  ['where did I park on Friday', [kept('2026-11-06 Parking spot'), day('2026-11-06')]],
  // Not in the vault: nothing should come back.
  ['what’s my sister’s name', []],
  ['when is my flight to Chicago', []],
  ['what’s my blood type', []],
  ['when is my chemistry lab', []],
  ['tell me a joke', []],
  ['what’s the weather like tomorrow', []],
  ['how do I boil an egg', []],
  ['what’s my Netflix password', []],
  // Chit-chat that names a day with notes: the day's notes aren't the answer.
  ['tell me a joke tonight', []],
  ['how are you doing this morning', []],
  ['is it going to rain on Friday', []],
  ['what time does the sun set today', []],
  ['set a timer for ten minutes this afternoon', []]
].map(([q, want]) => ({ q, want }));

/** Asked once the tuning was settled, to see it hold on words it wasn't chosen for. */
const HELD_OUT = [
  ['remind me what time my algorithms exam is on friday', [CMPSC]],
  ['what’s on the shopping list', ['Notes/Grocery list.md']],
  ['who do I live with', [ABOUT, 'People/Dev Patel.md']],
  ['what did I tell you about my parking spot', [kept('2026-11-06 Parking spot'), day('2026-11-06')]],
  ['what airline am I flying for thanksgiving', ['Trips/Thanksgiving trip home.md', day('2026-11-06')]],
  ['how long does the paneer recipe take', ['Recipes/Paneer butter masala.md']],
  ['who’s the TA for 465', [CMPSC]],
  ['what’s my supervisor’s name at the help desk', ['Work/HUB help desk.md']],
  ['what’s left to buy for the curry', [day('2026-11-04'), 'Notes/Grocery list.md']],
  ['when is my stats project due', ['School/STAT 318.md']],
  ['what did we decide about movie night', [day('2026-11-07'), 'Notes/Movies to watch.md']],
  ['when’s the hackathon', ['Projects/HackPSU 2026.md', ABOUT]],
  ['what’s the address of my apartment', ['Home/Apartment.md', ABOUT]],
  ['when is mom’s operation', ['People/Mom.md', day('2026-11-08')]],
  ['what should I review for the DP midterm', [LECTURE, CMPSC, day('2026-11-09')]],
  ['how much was my flight', ['Money/November budget.md']],
  ['what did I ask you to remember on thursday', [kept('2026-11-05 Dentist appointment'), day('2026-11-05')]],
  ['what’s my favorite color', []],
  ['when is my driving test', []],
  ['who’s my academic advisor', []],
  ['what was the score of the Eagles game', []]
].map(([q, want]) => ({ q, want }));

/** Writes the sample vault into `dir`, which must be new or empty: never over anyone's notes. */
function make(dir) {
  if (!dir) throw new Error('Say where: --make <folder>');
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} isn’t empty: the sample vault goes in a new or empty folder.`);
  for (const [rel, text] of Object.entries(SAMPLE)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  console.log(`Wrote the sample vault (${Object.keys(SAMPLE).length} files) to ${dir}`);
}

/** Frontmatter, as much of YAML as notes use: scalars, quoted strings, [a, b] and block lists. */
function frontmatter(text) {
  const found = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!found) return { data: {}, body: text };
  const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2');
  const data = {};
  let key = null;
  for (const line of found[1].split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && key) {
      data[key] = [...(Array.isArray(data[key]) ? data[key] : []), unquote(item[1])];
      continue;
    }
    const pair = /^([^\s:#][^:]*):(?:\s+(.*))?$/.exec(line);
    if (!pair) continue;
    key = pair[1].trim();
    const value = (pair[2] ?? '').trim();
    data[key] = !value ? null : value.startsWith('[') ? value.slice(1, -1).split(',').map(unquote).filter(Boolean) : unquote(value);
  }
  return { data, body: text.slice(found[0].length) };
}

/** A vault read the way vault.js reads one (root, listNotes, read), and only read. */
function readOnlyVault(root) {
  return {
    root,
    listNotes() {
      const notes = [];
      const walk = (dir, rel) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          const at = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(path.join(dir, entry.name), at);
          else if (/\.md$/i.test(entry.name)) {
            const stat = fs.statSync(path.join(dir, entry.name));
            notes.push({ rel: at, abs: path.join(dir, entry.name), mtimeMs: stat.mtimeMs, size: stat.size });
          }
        }
      };
      walk(root, '');
      return notes.sort((a, b) => (a.rel < b.rel ? -1 : 1));
    },
    read(rel) {
      const { data, body } = frontmatter(fs.readFileSync(path.join(root, rel), 'utf8'));
      const title = (typeof data.title === 'string' && data.title) || body.match(/^#[ \t]+(.+?)[ \t]*$/m)?.[1] || path.posix.basename(rel, '.md');
      return { rel, title, data, body };
    }
  };
}

const fixed = (n) => n.toFixed(2);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
};

/** hit@1, hit@3 and MRR of first-right-note ranks (0: not found in the top ten). */
function scores(ranks) {
  const n = ranks.length || 1;
  return {
    hit1: ranks.filter((rank) => rank === 1).length / n,
    hit3: ranks.filter((rank) => rank >= 1 && rank <= 3).length / n,
    mrr: ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / n
  };
}

/** Where each answerable question's first right note comes, and how many with no answer brought anything back. */
async function measure(index, answerable, unanswerable, options = {}) {
  const ranks = [];
  for (const question of answerable) {
    const found = await index.search(question.q, { limit: 10, perNote: 1, ...options });
    ranks.push(found.findIndex((hit) => question.want.includes(hit.rel)) + 1);
  }
  let wrong = 0;
  for (const { q } of unanswerable) if ((await index.search(q, options)).length) wrong++;
  return { ...scores(ranks), wrong };
}

async function evaluate(root) {
  const file = option('--questions');
  const set = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : { today: SAMPLE_TODAY, questions: args.includes('--held-out') ? HELD_OUT : SAMPLE_QUESTIONS };
  const today = option('--today') || set.today;
  const [year, month, date] = (today || '').split('-').map(Number);
  const now = today ? new Date(year, month - 1, date, 15, 0).getTime() : Date.now();
  const answerable = set.questions.filter((question) => question.want.length);
  const unanswerable = set.questions.filter((question) => !question.want.length);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jester-vault-eval-'));
  const options = { vault: () => readOnlyVault(root), file: path.join(scratch, 'index.json'), now: () => now, log: () => undefined };
  const index = createVaultIndex(options);
  let offline = null;
  try {
    let started = Date.now();
    const status = await index.refresh();
    console.log(`${root}: ${status.notes} notes in ${status.chunks} pieces, embedded in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    if (status.mode !== 'meaning') throw new Error(`Can’t measure meaning: ${status.error || status.mode}`);
    // The same index with Ollama off, as Jester searches then: by words. Made from the saved index, so it embeds nothing.
    offline = createVaultIndex({ ...options, fetchImpl: async () => Promise.reject(new TypeError('fetch failed')) });
    await offline.refresh();
    // Every question embedded once, before anything's timed.
    for (const { q } of set.questions) await index.search(q, { only: 'meaning' });

    // How like the question a right answer's best piece is, and the best piece of all for a question with no answer.
    const cosines = [];
    for (const question of set.questions) {
      const found = await index.search(question.q, { only: 'meaning', limit: 50, perNote: 50, tuning: { floor: -1 } });
      cosines.push({ question, top: found[0]?.score ?? 0, right: Math.max(0, ...found.filter((hit) => question.want.includes(hit.rel)).map((hit) => hit.score)) });
    }
    const right = cosines.filter((item) => item.question.want.length).map((item) => item.right);
    const none = cosines.filter((item) => !item.question.want.length).map((item) => item.top);
    console.log(`\nA right answer’s best cosine: min ${fixed(Math.min(...right))}, median ${fixed(median(right))}, max ${fixed(Math.max(...right))}`);
    console.log(`No answer, best cosine of all: min ${fixed(Math.min(...none))}, median ${fixed(median(none))}, max ${fixed(Math.max(...none))}`);
    for (const floor of [0.5, 0.55, 0.58, 0.6, 0.62, 0.65, 0.7]) {
      console.log(`  floor ${fixed(floor)}: right answers in reach ${right.filter((cos) => cos >= floor).length}/${right.length}, no-answer above it ${none.filter((cos) => cos >= floor).length}/${none.length}`);
    }

    const rows = [
      ['words only (BM25)', await measure(index, answerable, unanswerable, { only: 'words', tuning: { wordShare: 0 } })],
      ['meaning only (nomic-embed-text)', await measure(index, answerable, unanswerable, { only: 'meaning', tuning: { floor: -1 } })],
      ['hybrid, as Jester searches', await measure(index, answerable, unanswerable)],
      ['hybrid with Ollama off (words, nudges)', await measure(offline, answerable, unanswerable)]
    ];
    console.log(`\n${answerable.length} questions with an answer, ranked by note, the first right one counted; ${unanswerable.length} with none\n`);
    console.log('| ranking                                  | hit@1 | hit@3 | MRR  | no answer, yet found |');
    console.log('|------------------------------------------|-------|-------|------|----------------------|');
    for (const [name, result] of rows) {
      // A ranking with no floor finds something for everything: its false finds are the floor's, below.
      const wrong = name.startsWith('meaning only') ? `${none.filter((cos) => cos >= TUNING.floor).length} of ${none.length} above ${TUNING.floor}` : name.startsWith('words only') ? '' : `${result.wrong} of ${unanswerable.length}`;
      console.log(`| ${name.padEnd(40)} | ${fixed(result.hit1)}  | ${fixed(result.hit3)}  | ${fixed(result.mrr)} | ${wrong.padEnd(20)} |`);
    }
    const gated = await measure(index, [], unanswerable, { only: 'words' });
    console.log(`\nBy words alone at wordShare ${TUNING.wordShare}, a question with no answer found something ${gated.wrong} of ${unanswerable.length} times.`);

    started = performance.now();
    for (const { q } of set.questions) await index.search(q);
    console.log(`A search, its question already embedded: ${((performance.now() - started) / set.questions.length).toFixed(1)} ms`);

    if (args.includes('--sweep')) await sweep(index, offline, answerable, unanswerable);

    console.log('\nQuestions (hybrid rank · meaning rank · words rank: the top three)');
    for (const question of set.questions) {
      const ranked = async (opts) => {
        const found = await index.search(question.q, { limit: 10, perNote: 1, ...opts });
        return { rank: found.findIndex((hit) => question.want.includes(hit.rel)) + 1, found };
      };
      const hybrid = await ranked({});
      const meaning = (await ranked({ only: 'meaning', tuning: { floor: -1 } })).rank;
      const words = (await ranked({ only: 'words', tuning: { wordShare: 0 } })).rank;
      const missed = question.want.length ? hybrid.rank !== 1 : hybrid.found.length > 0;
      if (!missed && !args.includes('--verbose')) continue;
      const top = hybrid.found.slice(0, 3).map((hit) => `${hit.rel.replace(/^Jester\//, '').replace(/\.md$/, '')} (${hit.why} ${hit.score})`);
      console.log(`  ${missed ? '✗' : '✓'} “${question.q}” ${question.want.length ? `${hybrid.rank || '-'} · ${meaning || '-'} · ${words || '-'}` : 'no answer'}: ${top.join('; ') || 'nothing'}`);
    }
  } finally {
    index.close();
    offline?.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Other floors, word shares and nudges, with Ollama on, and other word shares with it off. */
async function sweep(index, offline, answerable, unanswerable) {
  const results = [];
  for (const floor of [0.55, 0.58, 0.6, 0.62, 0.64, 0.66]) {
    for (const wordShare of [0, 0.3, 0.4, 0.5, 0.6]) {
      for (const titleBonus of [0, 0.005, 0.01, 0.02]) {
        for (const dayBonus of [0, 0.01, 0.02, 0.03]) {
          const tuning = { floor, wordShare, titleBonus, dayBonus };
          results.push({ tuning, ...(await measure(index, answerable, unanswerable, { tuning })) });
        }
      }
    }
  }
  const pick = (want) => results.find(({ tuning }) => Object.entries(want).every(([key, value]) => tuning[key] === value));
  const cell = (found) => (found ? `${fixed(found.mrr)} / ${found.wrong}` : '-').padEnd(9);
  const floors = [...new Set(results.map((result) => result.tuning.floor))];
  const shares = [...new Set(results.map((result) => result.tuning.wordShare))];
  console.log(`\nSweep, Ollama on, with the tuned nudges (titleBonus ${TUNING.titleBonus}, dayBonus ${TUNING.dayBonus}): MRR / no-answer finds\n`);
  console.log(`| floor \\ wordShare | ${shares.map((share) => String(share).padEnd(9)).join(' | ')} |`);
  for (const floor of floors) {
    console.log(`| ${fixed(floor).padEnd(17)} | ${shares.map((wordShare) => cell(pick({ floor, wordShare, titleBonus: TUNING.titleBonus, dayBonus: TUNING.dayBonus }))).join(' | ')} |`);
  }
  const bonuses = [0, 0.005, 0.01, 0.02];
  console.log(`\nThe nudges at the tuned floor and word share (${TUNING.floor}, ${TUNING.wordShare}): MRR / no-answer finds\n`);
  console.log(`| titleBonus \\ dayBonus | ${[0, 0.01, 0.02, 0.03].map((bonus) => String(bonus).padEnd(9)).join(' | ')} |`);
  for (const titleBonus of bonuses) {
    console.log(`| ${String(titleBonus).padEnd(21)} | ${[0, 0.01, 0.02, 0.03].map((dayBonus) => cell(pick({ floor: TUNING.floor, wordShare: TUNING.wordShare, titleBonus, dayBonus }))).join(' | ')} |`);
  }
  const better = (a, b) => b.mrr - a.mrr || b.hit1 - a.hit1 || a.wrong - b.wrong;
  const best = [...results].sort(better)[0];
  console.log(`\nBest by MRR: ${JSON.stringify(best.tuning)}: hit@1 ${fixed(best.hit1)}, hit@3 ${fixed(best.hit3)}, MRR ${fixed(best.mrr)}, no-answer finds ${best.wrong}`);
  // With Ollama off there's no meaning: the words carry it alone.
  console.log('\nOllama off: wordShareAlone, hit@1, hit@3, MRR, no-answer finds');
  for (const wordShareAlone of [0, 0.1, 0.2, 0.3, 0.4, 0.5]) {
    const { hit1, hit3, mrr, wrong } = await measure(offline, answerable, unanswerable, { tuning: { wordShareAlone } });
    console.log(`  ${String(wordShareAlone).padEnd(4)} ${fixed(hit1)}  ${fixed(hit3)}  ${fixed(mrr)}  ${wrong} of ${unanswerable.length}`);
  }
}

try {
  if (args[0] === '--make') make(args[1]);
  else if (!args[0] || args[0].startsWith('--')) console.log('node desktop/scripts/vault-eval.mjs --make <folder>  |  <vault> [--held-out | --questions file.json] [--today YYYY-MM-DD] [--sweep] [--verbose]');
  else await evaluate(path.resolve(args[0]));
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
