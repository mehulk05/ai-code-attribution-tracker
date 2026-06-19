# Methodology: AI Code Detection & Codebase Attribution

This document describes how the AI code scanner calculates developer code shares, attributes line ownership, and estimates the percentage of AI-generated/assisted code in a repository.

---

## 1. Core Principles

The scanner operates purely on the **current active code** as of the **master** branch of a repository. It evaluates code in three dimensions:
1. **Developer Contribution Share:** The percentage of currently active lines of code in the repository owned by each developer.
2. **AI Code Style Forensics (The Lower Bound / Floor):** A conservative estimate based on durable stylistic signatures left by agentic AI tools.
3. **Commit Size and Velocity Heuristics (The Upper Bound / Ceiling):** A generous estimate based on the size and rate of single-commit file injections.

---

## 2. Defining Repository Scope

To ensure statistical accuracy, the scanner filters files before counting line counts:
*   **In-Scope Files:** Files with source extensions `.ts`, `.tsx`, `.js`, `.jsx`, `.vue`, `.scss`, `.html`, `.java`, `.py` inside the codebase.
*   **Excluded Files:** Files matching standard libraries (`node_modules/`), build folders (`/dist/`, `/build/`), testing specs (`.spec.ts`, `.test.ts`), static assets (`/assets/`), minimized production builds (`.min.`), or configuration lockfiles.
*   **The Master Branch Focus:** All operations are target-anchored to the local `origin/master` (or fallback `master`) branch. Even if the local clone is on a different checked-out branch, the scanner extracts and analyzes the files and history of the master branch.

---

## 3. Active Code Ownership (Git Blame)

To determine how much of the live codebase is owned by each developer:
1. The scanner retrieves the list of active files on the master branch:
   ```bash
   git ls-tree -r --name-only origin/master
   ```
2. For each file, it performs a porcelain Git Blame check:
   ```bash
   git blame --line-porcelain origin/master -- <file_path>
   ```
3. The lines are counted and mapped back to the merged, canonical identity of each developer (e.g. merging email aliases and excluding known automation bots).

---

## 4. Forensic AI Code Style Fingerprints (Conservative)

When agentic AI tools (like Claude or Gemini/Antigravity) generate whole modules or functions, they leave distinguishable stylistic markers in the finished text.

### A. Gemini / Antigravity Signatures
*   **Banner Divider Comments:** Formatting headers using long sets of equals/hyphens, e.g.:
    ```javascript
    // ====================== Lifecycle & Initialization ======================
    ```
*   **ALL-CAPS Section Labels:** Standard titles in uppercase comments.
*   **Python-Style Docstrings In-Body:** Gemini's Python training data occasionally leaks double-star docstrings inside JS/TS function braces:
    ```javascript
    function test() {
      /**
       * Docstring leaks here
       */
    }
    ```

### B. Claude Signatures
*   **Numbered Step Comments:** Procedural lists detailing logic flow:
    ```javascript
    // 1. Validate incoming payload
    // 2. Fetch connection token
    ```
*   **High JSDoc Block Density:** Idiomatic TypeScript JSDocs (`/** ... */`) placed above functions explaining types and parameters.

### C. Forensic Classification Scoring
Each file is scored on its density of signatures.
*   If signatures are present and confirmed, the file is classified as **AI** or **Mixed**.
*   The lines of that file are then blamed. If an AI-classified file contains lines owned by `Developer A`, those lines are registered as **AI-Assisted Lines** for that developer.

---

## 5. Commit Velocity & Size Heuristic (Generous)

Because developers using AI often generate entire features and copy-paste them in single-shot commits, the scanner monitors history for **code-dumping** behavior.
*   **Heuristic Criteria:** A non-merge commit is flagged as containing potential AI-generated code if:
  1. A developer adds **more than 120 lines** of code to a single file.
  2. The deletion ratio is **less than 5%** of the additions (`deletions / additions < 0.05`).
*   This represents a generous upper ceiling because it can capture manual copy-pastes, renames, or new file imports, but it brackets the AI usage range effectively.

---

## 6. Mathematical Results

*   **Forensic Floor:**
    $$\text{Forensic AI \%} = \frac{\text{LOC in AI Files} + 0.5 \times \text{LOC in Mixed Files}}{\text{Total Active LOC}}$$
*   **Heuristic Ceiling:**
    $$\text{Heuristic AI \%} = \frac{\text{Total Lines Added in Flagged Commits}}{\text{Total Lines Added in All Commits}}$$
*   **Developer Range:** Each developer's individual AI score is presented as a range from their **Forensic Floor** (lines owned in files classified as AI) to their **Heuristic Ceiling** (lines added in flagged commits).
