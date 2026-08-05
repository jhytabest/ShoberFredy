/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

const PORTAL_CHROME = new Set([
  'Favorisieren',
  'Notiz erstellen',
  'Notiz gespeichert.',
  'Notiz aktualisiert.',
  'Notiz gelöscht.',
  'Nachricht senden',
  'Nachricht schreiben',
  'Anfrage senden',
  'Telefonnummer anzeigen',
  'Zur Merkliste hinzufügen',
  'Anzeige teilen',
  'Anzeige melden',
  'Fehler',
  'Fehler.',
  'Schließen',
  'Drucken',
  'Beanstanden',
  'via E-Mail teilen',
  'via Facebook teilen',
  'via Pinterest teilen',
  'via X teilen',
  'Facebook Messenger',
  'Link erfolgreich kopiert!',
  'Anzeigenlink in Zwischenablage kopieren',
  'Angebote in der Umgebung einblenden',
  'Angebote in der Umgebung ausblenden',
  'Jetzt freischalten',
  'Jetzt ausfüllen',
  'Jetzt erstellen',
  'Schufa anfordern',
  'Nachweis hochladen',
  'Werbefrei surfen',
]);

const PROMOTIONAL_LINES = [
  /^WG-Gesucht\+$/i,
  /^Plus Mitglieder wissen mehr!?$/i,
  /^Was kostet mich der Umzug\??$/i,
  /^Services passend zur Wohnung$/i,
  /^Die passende Absicherung für deine Bewerbung$/i,
  /^Fakten und Zahlen der letzten 7 Tage$/i,
  /^Sie haben die maximale Anzahl von .* Favoriten erreicht/i,
];

export function prepareEvidenceCapture(capture, provider) {
  const rawText = String(capture.rawText ?? capture.fullText ?? '');
  const inactiveReason = detectInactiveReason(rawText, provider);
  return {
    ...capture,
    rawText,
    fullText: cleanEvidenceText(rawText),
    evidenceStatus: inactiveReason ? 'inactive' : 'detail',
    inactiveReason,
  };
}

function cleanEvidenceText(rawText) {
  const output = [];
  let previous = null;
  for (const rawLine of String(rawText || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) {
      if (output.length && output.at(-1) !== '') output.push('');
      continue;
    }
    if (PORTAL_CHROME.has(line) || PROMOTIONAL_LINES.some((pattern) => pattern.test(line))) continue;
    if (line === previous) continue;
    output.push(line);
    previous = line;
  }
  while (output.at(-1) === '') output.pop();
  return output.join('\n');
}

function detectInactiveReason(rawText, provider) {
  if (provider !== 'kleinanzeigen') return null;
  const opening = String(rawText || '').slice(0, 800);
  if (/Gelöscht/i.test(opening)) return 'Provider marks listing deleted';
  if (/Reserviert/i.test(opening)) return 'Provider marks listing reserved';
  return null;
}
