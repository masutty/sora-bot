import { defineView, paginationHandlers, paginationRow, type ViewDefinition } from "@/define";
import { settings } from "../settings";
import type { CaseRow } from "../types";
import { caseLine, plainReply } from "./case.render";

export interface CasesViewState {
    page: number;
    total: number;
    rows: CaseRow[];
}

export interface CasesViewDeps {
    userId: string;
    count(): Promise<number>;
    list(limit: number, offset: number): Promise<CaseRow[]>;
}

const pagesOf = (total: number) => Math.max(1, Math.ceil(total / settings.pageSize));

/** `cases <user>`: every Case of the member, newest first, one page at a time. */
export function casesView(deps: CasesViewDeps): ViewDefinition<CasesViewState, void, void> {
    const load = async (s: CasesViewState) => {
        s.rows = await deps.list(settings.pageSize, s.page * settings.pageSize);
    };
    const paging = paginationHandlers<CasesViewState>({ pages: (s) => pagesOf(s.total) });
    const on = Object.fromEntries(
        Object.entries(paging).map(([key, handler]) => [
            key,
            async (c: Parameters<typeof handler>[0]) => {
                await handler(c);
                await load(c.state);
            },
        ]),
    );
    return defineView<CasesViewState, void, void>({
        name: "moderation.cases",
        initial: async () => {
            const state = { page: 0, total: await deps.count(), rows: [] };
            await load(state);
            return state;
        },
        render: (s, kit) => {
            const body = s.rows.length === 0 ? "No cases." : s.rows.map(caseLine).join("\n");
            const payload = plainReply(`**Cases of <@${deps.userId}>**\n-# ${s.total} ${s.total === 1 ? "case" : "cases"}\n\n${body}`);
            const pages = pagesOf(s.total);
            return pages > 1 ? { ...payload, components: [...payload.components, paginationRow(kit, s.page, pages)] } : payload;
        },
        on,
    });
}
