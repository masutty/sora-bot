type Quip = {
    text: string;
    funnyLevel: number;
};

export enum QuipTypes {
    THINKING = "thinking",
    SUCCESS = "success",
    FAILURE = "failure",
}

export const DEFAULT_FUNNY_LEVEL = Number.parseInt(
    process.env.DEFAULT_QUIP_JOKE_LEVEL ?? "0",
    10,
);

export const THINKING_QUIPS = [
    { text: "Processing...", funnyLevel: 0 },
    { text: "Thinking...", funnyLevel: 0 },
    { text: "Working on it...", funnyLevel: 0 },
    { text: "One moment...", funnyLevel: 0 },
    { text: "Analyzing request...", funnyLevel: 0 },
    { text: "Calculating response...", funnyLevel: 0 },
    { text: "Cooking something up...", funnyLevel: 1 },
    { text: "Brewing the response...", funnyLevel: 1 },
    { text: "Summoning the answer...", funnyLevel: 1 },
    { text: "Gathering brainpower...", funnyLevel: 1 },
    { text: "Consulting the archives...", funnyLevel: 1 },
    { text: "Reticulating splines...", funnyLevel: 1 },
    { text: "Consulting the void...", funnyLevel: 2 },
    { text: "Loading brain cells...", funnyLevel: 2 },
    { text: "Negotiating with the API gods...", funnyLevel: 2 },
    { text: "Untangling spaghetti code...", funnyLevel: 2 },
    { text: "Generating cleverness...", funnyLevel: 2 },
    { text: "Searching for the least cursed solution...", funnyLevel: 2 },
    { text: "Doing wizard math...", funnyLevel: 3 },
    { text: "The hamsters are spinning at maximum velocity...", funnyLevel: 3 },
    { text: "Convincing electrons to cooperate...", funnyLevel: 3 },
    { text: "Vibecoding the answer...", funnyLevel: 3 },
    { text: "Stealing knowledge from the universe...", funnyLevel: 3 },
    { text: "Asking Stack Overflow spiritually...", funnyLevel: 3 },
    { text: "Rotating the problem until it works...", funnyLevel: 3 },
] as const satisfies readonly Quip[];

export const SUCCESS_QUIPS = [
    { text: "Done!", funnyLevel: 0 },
    { text: "Success!", funnyLevel: 0 },
    { text: "Completed successfully.", funnyLevel: 0 },
    { text: "All set!", funnyLevel: 0 },
    { text: "Finished.", funnyLevel: 0 },
    { text: "Task completed.", funnyLevel: 0 },
    { text: "Operation successful.", funnyLevel: 0 },
    { text: "Everything went smoothly.", funnyLevel: 1 },
    { text: "That worked perfectly.", funnyLevel: 1 },
    { text: "Mission accomplished.", funnyLevel: 1 },
    { text: "We’re good to go.", funnyLevel: 1 },
    { text: "Massive W.", funnyLevel: 2 },
    { text: "We take those.", funnyLevel: 2 },
    { text: "Common success.", funnyLevel: 2 },
    { text: "The code survived.", funnyLevel: 2 },
    { text: "No errors this time.", funnyLevel: 2 },
    { text: "Task completed without exploding.", funnyLevel: 3 },
    { text: "The duct tape held together.", funnyLevel: 3 },
    { text: "Against all odds, it worked.", funnyLevel: 3 },
    { text: "Ship it before it breaks again.", funnyLevel: 3 },
    { text: "The gremlins are satisfied.", funnyLevel: 3 },
    { text: "Achievement unlocked: functionality.", funnyLevel: 3 },
] as const satisfies readonly Quip[];

export const FAILURE_QUIPS = [
    { text: "Something went wrong.", funnyLevel: 0 },
    { text: "Task failed.", funnyLevel: 0 },
    { text: "Unable to complete the request.", funnyLevel: 0 },
    { text: "An error occurred.", funnyLevel: 0 },
    { text: "That didn’t work.", funnyLevel: 0 },
    { text: "Execution failed.", funnyLevel: 0 },
    { text: "Oops, something broke.", funnyLevel: 1 },
    { text: "I hit a snag.", funnyLevel: 1 },
    { text: "The operation could not be completed.", funnyLevel: 1 },
    { text: "Well... that was unfortunate.", funnyLevel: 1 },
    { text: "The hamsters stopped running.", funnyLevel: 2 },
    { text: "I tripped over a semicolon.", funnyLevel: 2 },
    { text: "The code fought back.", funnyLevel: 2 },
    { text: "Something caught fire internally.", funnyLevel: 2 },
    { text: "Unexpected chaos detected.", funnyLevel: 2 },
    { text: "Catastrophic successn't.", funnyLevel: 3 },
    { text: "Skill issue detected.", funnyLevel: 3 },
    { text: "The spaghetti escaped the container.", funnyLevel: 3 },
    { text: "The gremlins won this round.", funnyLevel: 3 },
    { text: "Have you tried turning reality off and on again?", funnyLevel: 3 },
    { text: "Somewhere, a developer is crying.", funnyLevel: 3 },
    { text: "The vibes were not immaculate.", funnyLevel: 3 },
] as const satisfies readonly Quip[];

const QUIPS: Record<QuipTypes, readonly Quip[]> = {
    [QuipTypes.THINKING]: THINKING_QUIPS,
    [QuipTypes.SUCCESS]: SUCCESS_QUIPS,
    [QuipTypes.FAILURE]: FAILURE_QUIPS,
};

export function getRandomQuip(
    type: QuipTypes,
    maxFunnyLevel = 0,
): string {
    const allowed = QUIPS[type].filter(
        (q) => q.funnyLevel <= maxFunnyLevel,
    );

    const pool = allowed.length > 0
        ? allowed
        : QUIPS[type];

    return pool[Math.floor(Math.random() * pool.length)].text;
}

export function getSuccessQuip(maxFunnyLevel = 0): string {
    return getRandomQuip(QuipTypes.SUCCESS, maxFunnyLevel);
}

export function getFailureQuip(maxFunnyLevel = 0): string {
    return getRandomQuip(QuipTypes.FAILURE, maxFunnyLevel);
}

export function getThinkingQuip(maxFunnyLevel = 0): string {
    return getRandomQuip(QuipTypes.THINKING, maxFunnyLevel);
}
