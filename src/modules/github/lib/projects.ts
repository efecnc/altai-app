import { github } from "./github";
import type { RepoSlug } from "./items";

export type ProjectSummary = {
  id: string;
  number: number;
  title: string;
  url: string;
  closed: boolean;
};

export type BoardColumn = {
  /** Status single-select option id, or null for the synthetic "No Status". */
  id: string | null;
  name: string;
};

export type CardContentType = "Issue" | "PullRequest" | "DraftIssue";

export type BoardCard = {
  itemId: string;
  statusOptionId: string | null;
  title: string;
  type: CardContentType;
  number: number | null;
  url: string | null;
  /** OPEN / CLOSED / MERGED for issues & PRs; null for draft items. */
  state: string | null;
  isDraft: boolean;
};

export type Board = {
  projectId: string;
  title: string;
  /** Null when the project has no single-select "Status" field. */
  statusFieldId: string | null;
  columns: BoardColumn[];
  cards: BoardCard[];
  /** True when the project has more items than the pagination cap fetched. */
  truncated: boolean;
};

export const NO_STATUS_COLUMN: BoardColumn = { id: null, name: "No Status" };

const LIST_PROJECTS = `
  query($owner:String!, $repo:String!) {
    repository(owner:$owner, name:$repo) {
      projectsV2(first:25, orderBy:{field:TITLE, direction:ASC}) {
        nodes { id number title url closed }
      }
    }
  }
`;

const BOARD_PAGE = `
  query($id:ID!, $cursor:String) {
    node(id:$id) {
      ... on ProjectV2 {
        title
        field(name:"Status") {
          ... on ProjectV2SingleSelectField { id name options { id name } }
        }
        items(first:50, after:$cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            fieldValueByName(name:"Status") {
              ... on ProjectV2ItemFieldSingleSelectValue { optionId }
            }
            content {
              __typename
              ... on Issue { number title url state }
              ... on PullRequest { number title url state isDraft }
              ... on DraftIssue { title }
            }
          }
        }
      }
    }
  }
`;

const SET_STATUS = `
  mutation($project:ID!, $item:ID!, $field:ID!, $option:String!) {
    updateProjectV2ItemFieldValue(input:{
      projectId:$project, itemId:$item, fieldId:$field,
      value:{ singleSelectOptionId:$option }
    }) { projectV2Item { id } }
  }
`;

const CLEAR_STATUS = `
  mutation($project:ID!, $item:ID!, $field:ID!) {
    clearProjectV2ItemFieldValue(input:{
      projectId:$project, itemId:$item, fieldId:$field
    }) { projectV2Item { id } }
  }
`;

/** Projects v2 boards linked to a repository. */
export async function listRepoProjects(
  slug: RepoSlug,
): Promise<ProjectSummary[]> {
  const data = await github.graphql<{
    repository: { projectsV2: { nodes: ProjectSummary[] } } | null;
  }>(LIST_PROJECTS, { owner: slug.owner, repo: slug.repo });
  return data.repository?.projectsV2.nodes ?? [];
}

type RawItem = {
  id: string;
  fieldValueByName: { optionId?: string } | null;
  content:
    | {
        __typename: CardContentType;
        number?: number;
        title?: string;
        url?: string;
        state?: string;
        isDraft?: boolean;
      }
    | null;
};

type BoardPageNode = {
  title: string;
  field: { id: string; options: { id: string; name: string }[] } | null;
  items: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: RawItem[];
  };
};

type BoardPageResponse = { node: BoardPageNode | null };

/** Fetch a project's Status columns and all item cards (paginated, capped). */
export async function getProjectBoard(projectId: string): Promise<Board> {
  let cursor: string | null = null;
  let title = "";
  let statusFieldId: string | null = null;
  let columns: BoardColumn[] = [];
  let truncated = false;
  const cards: BoardCard[] = [];
  // Cap pagination so a huge project can't spin forever; 6 pages = 300 items.
  const MAX_PAGES = 6;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data: BoardPageResponse = await github.graphql<BoardPageResponse>(
      BOARD_PAGE,
      { id: projectId, cursor },
    );
    const node = data.node;
    if (!node) break;
    title = node.title;
    if (node.field) {
      statusFieldId = node.field.id;
      columns = node.field.options.map((o) => ({ id: o.id, name: o.name }));
    }
    for (const it of node.items.nodes) {
      const c = it.content;
      if (!c) continue;
      cards.push({
        itemId: it.id,
        statusOptionId: it.fieldValueByName?.optionId ?? null,
        title: c.title ?? "(untitled)",
        type: c.__typename,
        number: c.number ?? null,
        url: c.url ?? null,
        state: c.state ?? null,
        isDraft: c.isDraft ?? false,
      });
    }
    if (!node.items.pageInfo.hasNextPage) break;
    // Hit the page cap with more items still available → mark truncation.
    if (page === MAX_PAGES - 1) {
      truncated = true;
      break;
    }
    cursor = node.items.pageInfo.endCursor;
    if (!cursor) break;
  }

  return { projectId, title, statusFieldId, columns, cards, truncated };
}

const REPO_CONTENT_IDS = `
  query($owner:String!, $repo:String!) {
    repository(owner:$owner, name:$repo) {
      issues(first:50, states:OPEN) { nodes { id } }
      pullRequests(first:50, states:OPEN) { nodes { id } }
    }
  }
`;

const ADD_ITEM = `
  mutation($project:ID!, $content:ID!) {
    addProjectV2ItemById(input:{ projectId:$project, contentId:$content }) {
      item { id }
    }
  }
`;

/** Node IDs of the repo's open issues and PRs, for adding to a project. */
export async function listOpenContentIds(slug: RepoSlug): Promise<string[]> {
  const data = await github.graphql<{
    repository: {
      issues: { nodes: { id: string }[] };
      pullRequests: { nodes: { id: string }[] };
    } | null;
  }>(REPO_CONTENT_IDS, { owner: slug.owner, repo: slug.repo });
  const repo = data.repository;
  if (!repo) return [];
  return [
    ...repo.issues.nodes.map((n) => n.id),
    ...repo.pullRequests.nodes.map((n) => n.id),
  ];
}

/**
 * Add open issues & PRs to a project. Only the benign "already in project"
 * error is swallowed; a real failure (missing scope, rate limit, auth) is
 * rethrown when nothing could be added, so the caller can surface it instead of
 * silently reporting success on an empty board.
 */
export async function populateProject(
  projectId: string,
  slug: RepoSlug,
): Promise<{ added: number; failed: number }> {
  const contentIds = await listOpenContentIds(slug);
  let added = 0;
  let failed = 0;
  let firstError: string | null = null;
  for (const content of contentIds) {
    try {
      await github.graphql(ADD_ITEM, { project: projectId, content });
      added++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const lower = msg.toLowerCase();
      const isDuplicate = lower.includes("already") && lower.includes("project");
      if (!isDuplicate) {
        failed++;
        if (!firstError) firstError = msg;
      }
    }
  }
  // Every add failed for a real reason → bubble it up.
  if (added === 0 && firstError) throw new Error(firstError);
  return { added, failed };
}

/** Move a card to a Status column (or clear it when optionId is null). */
export async function setCardStatus(
  projectId: string,
  fieldId: string,
  itemId: string,
  optionId: string | null,
): Promise<void> {
  if (optionId === null) {
    await github.graphql(CLEAR_STATUS, {
      project: projectId,
      item: itemId,
      field: fieldId,
    });
    return;
  }
  await github.graphql(SET_STATUS, {
    project: projectId,
    item: itemId,
    field: fieldId,
    option: optionId,
  });
}
