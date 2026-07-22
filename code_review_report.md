# 🔍 Revisione Staging

**Intento**: Evitare che gli artefatti skill-creator/skill-forge finiscano in sync e in Cursor come skill `skill-snapshot`, con migrazione automatica locale (promote + delete selettiva) e purge remoto mirato, senza full push e senza distruggere workspace skill-forge attivi.

**Branch**: `release/v0.9.0` (working tree) → `HEAD` (`v0.10.2`)
**File modificati**: 10 file di logica/docs/test (+859/−2, `--ignore-cr-at-eol`); `package.json` / `tests/conflicts.test.ts` ancora staged ma senza delta logico (CRLF)
**Copertura review**: 10/10 file di cambio reale letti per intero (`src/skill-artifacts-migrate.ts`, `src/paths.ts`, `src/extension.ts`, `src/push.ts`, `src/pull.ts`, `src/import.ts`, test, CHANGELOG, README). Gather manuale (Python non disponibile). 22 test unitari passano — non bastano a coprire i path di perdita dati sotto.
**Distribuzione finding**: 2 CRITICA, 2 ALTA, 1 MEDIA, 1 BASSA
**Verdetto**: 🔴 NON PRONTO

---

## Problemi di completezza (cose lasciate in sospeso)

### C-1: Delete del workspace se esiste già un `SKILL.md` minimale — perde il contenuto ricco dello snapshot — Severità: CRITICA
**File**: `src/skill-artifacts-migrate.ts` (righe 69–88)
**Cosa manca**: La promote scatta solo se `skills/<name>/SKILL.md` **non esiste**. Se esiste anche solo uno stub, non si fa merge. Poi, se il workspace è disposable, viene `fs.rm` intero — inclusa `skill-snapshot/` con script, references, templates, ecc.
**Impatto se rilasciato così com'è**: Scenario esatto — `skills/code-review/SKILL.md` presente (solo frontmatter), `skills/code-review-workspace/skill-snapshot/` ha l’albero completo. All’activate: nessuna promote, workspace cancellato, **script e asset persi per sempre**. È il caso più pericoloso per un processo “non perdere nulla”.
**Sistemazione proposta**:
```typescript
// Prima di qualsiasi rm del workspace:
// 1) scegli promote source
// 2) mergeMissingFromSnapshot(sourceDir, targetDir) — copia solo file assenti, mai overwrite
// 3) solo dopo merge riuscito, se disposable → rm workspace

async function mergeMissingFromSnapshot(srcDir: string, destDir: string): Promise<number> {
  let copied = 0;
  await fs.mkdir(destDir, { recursive: true });
  for (const entry of await fs.readdir(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copied += await mergeMissingFromSnapshot(s, d);
    } else if (entry.isFile() && !(await pathExists(d))) {
      await fs.copyFile(s, d);
      copied += 1;
    }
  }
  return copied;
}

// Nel loop *-workspace:
const sourceName = await findPromoteSource(dirPath);
if (sourceName) {
  const n = await mergeMissingFromSnapshot(path.join(dirPath, sourceName), targetDir);
  if (n > 0 || !(await pathExists(targetSkillMd))) {
    promoted.push({ from: path.posix.join(relDir, sourceName), to: path.posix.join("skills", baseName) });
  }
}
if (await isDisposableSkillWorkspace(dirPath)) {
  await fs.rm(dirPath, { recursive: true, force: true });
  removed.push(relDir);
}
```

### C-2: Purge remoto degli artifact **prima** di pubblicare le skill promosse — Severità: CRITICA
**File**: `src/extension.ts` (righe 285–289), `src/skill-artifacts-migrate.ts` (`purgeRemoteSkillArtifacts`)
**Cosa manca**: Su activate: (1) migrate locale, (2) purge delle sole chiavi artifact dal manifest remoto. Le skill promosse in `skills/<name>/` **non** vengono caricate sul remoto in quel passaggio.
**Impatto se rilasciato così com'è**: Remoto aveva solo `dot-cursor/skills/foo-workspace/skill-snapshot/...` (il bug originale). Macchina A attiva l’estensione → promote locale a `skills/foo/`, purge remoto degli snapshot. Macchina B (vuota o pull successivo) non trova né artifact né skill vera sul remoto. Finché A non fa un push “normale”, la skill esiste solo su A; se A non pusha mai, le altre macchine la perdono.
**Sistemazione proposta**:
```typescript
// Dopo migrate, se ci sono promote (o skill vere nuove non remote):
// 1) package solo le chiavi promosse / skill recuperate
// 2) writeFiles(promotedFiles + manifest aggiornato)
// 3) deleteNames = artifact keys
// Atomico nello stesso writeFiles:

await backend.writeFiles(
  {
    ...promotedRemoteFiles,
    "manifest.json": JSON.stringify(nextManifest, null, 2),
  },
  { deleteNames: artifactNames }
);
```
`purgeRemoteSkillArtifacts` deve accettare i path promossi da migrate (ritorno arricchito) e uplodarli nello stesso commit/write del delete.

### C-3: File non-directory alla root del workspace disposable vengono buttati — Severità: ALTA
**File**: `src/skill-artifacts-migrate.ts` (`isDisposableSkillWorkspace`, righe 256–277)
**Cosa manca**: Solo le **directory** non-artifact rendono il workspace non-disposable. File alla root (`eval_metadata.json`, note, log) non contano → workspace cancellato comunque.
**Impatto se rilasciato così com'è**: Metadati/eval e file di lavoro a root di `*-workspace/` spariscono all’activate.
**Sistemazione proposta**:
```typescript
export async function isDisposableSkillWorkspace(dirPath: string): Promise<boolean> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  let hasArtifact = false;
  for (const entry of entries) {
    if (entry.isFile()) {
      return false; // qualsiasi file a root ⇒ non disposable
    }
    if (entry.isDirectory()) {
      if (isSkillArtifactSegment(entry.name)) {
        hasArtifact = true;
        continue;
      }
      return false;
    }
  }
  return hasArtifact;
}
```

### C-4: `removeNestedArtifactDirs` sotto skill reali non fa merge — Severità: ALTA
**File**: `src/skill-artifacts-migrate.ts` (righe 312–331)
**Cosa manca**: Stesso pattern di C-1: se `skills/foo/skill-snapshot/` ha file assenti da `skills/foo/`, vengono cancellati senza merge.
**Impatto se rilasciato così com'è**: Snapshot nested usati come backup locale sotto la skill vera vengono persi al primo activate/push/pull.
**Sistemazione proposta**: Prima di `fs.rm` su ogni nested artifact dir, `mergeMissingFromSnapshot(artifactDir, skillDir)`.

---

## Problemi di stabilità (cose che potrebbero rompersi)

### S-1: Promote preferisce sempre `skill-snapshot` (baseline vecchia) del variant più recente — Severità: MEDIA
**File**: `src/skill-artifacts-migrate.ts` (`findPromoteSource`, righe 279–309)
**Cosa può andare storto**: Con live skill assente e presenti sia `skill-snapshot` (old) sia `skill-snapshot-grilling` (più recente), si promuove la baseline vecchia.
**Impatto**: Skill recuperata “funziona” ma è una versione indietro. ⚠️ da verificare se in skill-forge il variant è sempre intermedio e non “migliore”.
**Sistemazione proposta**:
```typescript
// Tra candidati con SKILL.md, preferire mtime più recente di SKILL.md
// oppure: skill-snapshot-* / skill-*-backup prima di skill-snapshot quando si recupera
// una skill mancante (non quando si stabilisce un baseline di eval).
```

### S-2: Top-level `skills/skill-snapshot/` cancellato senza destinazione di promote — Severità: BASSA
**File**: `src/skill-artifacts-migrate.ts` (righe 58–61)
**Cosa può andare storto**: Non c’è un nome skill di destinazione; il contenuto viene eliminato. Caso raro (layout skill-creator usa `*-workspace/skill-snapshot/`).
**Impatto**: Perdita se qualcuno ha spostato manualmente lo snapshot a top-level.
**Sistemazione proposta**: Non cancellare; al massimo escludere dalla sync (già fatto da `isSkillSyncArtifact`) oppure spostare in `skills/_recovered-skill-snapshot-<timestamp>/` senza nome `skill-snapshot`.

---

## Problemi di sicurezza

Nessuno nuovo rilevante (purge usa token già configurato, niente prompt, niente full push di settings).

---

## Problemi di performance

Nessuno bloccante.

---

## Problemi frontend

Nessuno.

---

## Problemi nei test

### T-1: Mancano i test sui path di perdita dati — Severità: (coperto da C-1/C-2)
I 22 test attuali verificano promote “happy path”, backup-only, iteration preservate, skill legittima `*-workspace`. **Non** verificano:
- skill reale minimale + snapshot ricco → merge prima del delete
- purge remoto che deve includere upload delle promote
- file a root che bloccano disposable
- nested artifact merge sotto skill reale

Vanno aggiunti insieme alle fix C-1–C-4.

---

## Note di qualità (non bloccanti)

### Q-1: `package.json` / `tests/conflicts.test.ts` nello staging senza cambio logico
Non includerli nel commit (solo CRLF).

### Q-2: `code_review_report.md` untracked in root
Escluso dal VSIX da `.vscodeignore` (`**` + whitelist). Ok non shippare; si può aggiungere a `.gitignore` se disturba.

---

## Cosa funziona bene ✅

- Niente full push su activate (fix della review precedente): purge è manifest + `deleteNames` mirati.
- Workspace con `iteration-*` non vengono cancellati (skill-forge attivo preservato).
- Skill legittime `my-agent-workspace/` non sono più trattate come artifact.
- Pull/import skippano le chiavi artifact; enumerate le esclude dal push futuro.
- Promote con fallback `skill-snapshot` → `skill-snapshot-*` → `skill-*-backup` quando la skill vera manca del tutto.
- Documentazione CHANGELOG/README allineata all’intento anti-full-push.

---

## Prossimi step

Come vuoi procedere?

1. **Applica tutte le correzioni** — applicherò tutte le correzioni proposte (priorità: merge-before-delete + upload promote prima del purge remoto)
2. **Applica solo i problemi bloccanti** — solo CRITICA e ALTA
3. **Applica in modo selettivo** — dimmi quali ID (es. "applica C-1, C-2")
4. **Solo il report** — non applicare nulla
5. **Parliamone prima** — discutiamo risultati specifici
