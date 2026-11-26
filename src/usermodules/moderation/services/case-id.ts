/** No 0, O, 1, I or L, so an ID read aloud or typed from a screenshot stays unambiguous. */
export const CASE_ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CASE_ID_LENGTH = 7;

const CASE_ID_PATTERN = new RegExp(`^[${CASE_ID_ALPHABET}]{${CASE_ID_LENGTH}}$`);

export function newCaseId(random: () => number = Math.random): string {
    let id = "";
    for (let i = 0; i < CASE_ID_LENGTH; i++) {
        id += CASE_ID_ALPHABET[Math.min(Math.floor(random() * CASE_ID_ALPHABET.length), CASE_ID_ALPHABET.length - 1)];
    }
    return id;
}

/** Uppercases user input; `null` when it is not a valid Case ID. */
export function normalizeCaseId(input: string): string | null {
    const id = input.trim().toUpperCase();
    return CASE_ID_PATTERN.test(id) ? id : null;
}
