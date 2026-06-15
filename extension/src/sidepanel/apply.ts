// Turn a job-posting URL into the goal string the agent runs. The wording is
// chosen so the existing keyword matcher routes it to seed-job-application, and
// so the executor fills + attaches + stops (never submits).
export function buildApplyGoal(url: string): string {
  return `Apply to the job application at ${url.trim()}: read the application form, fill every field from my profile, and attach my résumé with the upload tool. Do NOT submit — stop when the form is filled so I can review and submit it myself.`;
}
