export type MasterRead = { line: number; tool: string; target: string };
export type MasterReadsReport = { reads: MasterRead[]; mainCalls: number; overLimit: number };
export function countMasterReads(
  entries: ReadonlyArray<unknown>,
  opts: { maxLines: number },
): MasterReadsReport;
