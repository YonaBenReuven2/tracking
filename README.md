# Practice log

A small web app that replaces `Tracking.xlsx`. You log what you sang each day. The board
shows every exercise coloured by how long ago you last did it, and the colour keeps
getting darker past the three weeks the spreadsheet stopped at.

The app is plain HTML, CSS and JavaScript, with no build step. It's served from GitHub
Pages and can be installed from Chrome or Edge so it opens in its own window. The log
itself is one JSON file in a separate **private** repo, written through GitHub's API.

## Files

| | |
|---|---|
| `index.html`, `style.css`, `app.js` | The page |
| `core.js` | The data model: merging, staleness, colours, stats. No DOM, no network |
| `github.js` | Reading and writing the log file through the GitHub contents API |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installing it as an app and opening it offline |
| `tools/import_tracking.py` | Converts the old spreadsheet into a log file |
| `tests/` | Tests for `core.js`, `github.js` (against a fake GitHub) and the importer |
| `import/` | The converted spreadsheet and the importer's report. Git-ignored on purpose |

## Setting it up

1. **Publish the app.** Create an empty public repo called `tracking` on GitHub (no
   README), then in this folder:
   ```
   git init -b main
   git add .
   git status            # import/ must NOT be listed
   git commit -m "Practice log app"
   git remote add origin https://github.com/YonaBenReuven2/tracking.git
   git push -u origin main
   ```
   In the repo's Settings → Pages, set the source to *Deploy from a branch*, branch
   `main`, folder `/ (root)`. The app will then be at
   `https://yonabenreuven2.github.io/tracking/`.
2. **Make the data repo.** Create a **private** repo, for example `tracking-data`, and
   tick "Add a README" so it isn't empty.
3. **Make a token.** Go to GitHub → Settings → Developer settings → Fine-grained tokens →
   Generate new token. For Repository access, choose *Only select repositories* and pick
   `tracking-data`. Under Repository permissions, set **Contents: Read and write**.
   Nothing else is needed.
4. **Connect.** Open the app, go to Settings, and fill in your username, `tracking-data`
   and the token. Press *Save and sync*.
5. **Bring in your history.** In Settings → *Load a log file*, pick `import/log.json`.
   The first sync then commits the whole history to the data repo. (If you'd already
   loaded an earlier version of it, use *Start over from a file* instead.)
6. **Install it** (optional). In Chrome or Edge, use the install icon at the right of the
   address bar.

## Organising exercises

Everything here is on the Exercises tab.

- **Categories.** Each category is its own section on the board. Use *Categories* to add,
  rename, reorder or delete them; deleting one moves its exercises to another. Choose an
  exercise's category on its page.
- **Variations.** Each exercise has a list of variations you rotate through. Each one gets
  a small square on the tile, coloured by how long ago you did it, and a chip when you
  log. An entry can have several variations, for example sfch in set order and in random
  order. Anything you type as a new variation is kept under *Also logged*, where you can
  add it to the list.
- **Renaming a variation** changes every entry that used it. Renaming it to a name that
  already exists merges the two. *Name them* gives entries logged with no variation a name.
- **Combining.** *Make it a variation of another exercise* moves all of an exercise's
  entries into another one, marked with a variation (its old name by default), and takes
  it off the list. Undo is in the message that appears straight after.
- **The day page** has three parts: what you did in your own practice, what you did at a
  lesson, and below them all your exercises. The outlined section is where clicking an
  exercise logs it. Switch with *Log here*, or with *Clicking one logs it to* above the
  exercises. The log dialog can also send a single entry to the other section.
- **Every log is its own line**, so the same exercise can appear twice in a session (two
  variations of a scale, say), or in both your own practice and the lesson. A tile shows
  how many times it was done that day. Settings → Board decides whether lesson exercises
  count towards the colours.
- **Archive** takes an exercise off the board and keeps its history. Only exercises with
  no entries can be deleted.

## How syncing works

- Every change is saved in the browser at once, then pushed to GitHub about a second
  later. The status at the top right shows "Saving…", then "Synced 21:04". If you're
  offline it says so and tries again later. Nothing is lost in the meantime.
- Each save reads the file, merges, and writes it back with the version it read. If
  something else wrote in between, GitHub refuses the write; the app merges again and
  retries.
- Merging can't lose anything. Each entry has an id and a last-changed time: two copies
  combine by taking every entry, and where both have the same one, the newer version wins.
  Deleting marks an entry deleted rather than erasing it, so a delete survives a merge
  with an older copy.
- The file has one record per line, so each commit's diff shows exactly what you logged.
  Commit messages say what changed, for example `2026-10-27: ree (up to no head), brr`.
- If the file on GitHub can't be read (edited by hand into invalid JSON, say), the app
  stops and shows an error. It never overwrites a file it can't read.
- Big changes (combining, renaming a variation, deleting a category) get their own commit
  message, for example `Combine evil laugh 1 into evil laugh as 1`.
- *Settings → Start over from a file* replaces everything with a file, both here and on
  GitHub. It's meant for a corrected import. The old file stays in the repo's history.
- The token is kept in this browser's storage for your `github.io` site, which your other
  Pages apps (such as the ear trainer) share. That's fine because they're all yours. Just
  don't add third-party scripts to any of them.

## The data file

```
{
  "app": "practice-log",
  "version": 2,
  "categories": [ {"id","name","order","updated"} ],
  "exercises":  [ {"id","name","category","variations":[...],"archived","order","updated"} ],
  "days":       [ {"id":"YYYY-MM-DD","label","note","updated"} ],
  "entries":    [ {"id","date","exercise","variations":[...],"lesson"?,"note","updated"} ]
}
```

`exercise` in an entry is the exercise's `id`, and `category` is the category's `id`, so
renaming either keeps the history. Any record can also have `"deleted": true`.
The file is easy to load in pandas:
`pd.DataFrame(json.load(open("log.json", encoding="utf-8"))["entries"])`.

## The importer

```
pip install openpyxl
python tools/import_tracking.py "path\to\Tracking.xlsx" -o import\log.json
```

How it reads the sheet:

- Cells from column B up to the first empty cell are your own practice. Anything after an
  empty cell, or a row that only starts at column E or later, was at a lesson. A few
  rows with no gap are set by hand in `LESSON_STARTS`.
- Each cell is one entry, so an exercise written twice stays as two entries.
- Breathing: `sfch` and `sfch no random` are sfch in *set order*, `all breathing` is set
  and random order, `sfch songs` is *songs*, and `5 sfch` is kept as an old variation.
  A number of seconds is the separate *holding breath* exercise.
- Exercises that are variations of one another are combined: evil laugh 1/2/3, hum +
  nasal hum, kiki + hallelujah 3, vavevivovu + vavevivovu - a + mimema + va, and gliss +
  dynamic vi (as *octave*). Plain gliss entries are *compound*.

It prints a report of every cell it had to interpret: typos it fixed, lesson cells,
second lines joined to a variation, cells read as notes. The rules are tables at the top
of the script. If something is read wrong, change the table and re-run it. To bring a
corrected import into a log you've already been using, give it a time just after the
`"updated"` time in the file you loaded, then use *Load a log file*:
```
python tools/import_tracking.py "path\to\Tracking.xlsx" -o import\log.json --stamp 2026-10-28T13:05:10.000Z
```
The corrected entries replace the old import, and anything you changed or logged in the
app since stays. *Start over from a file* also works, but it removes everything that
isn't in the file.

## Tests

```
node --test "tests/*.test.js"
python tests/test_import.py
```
