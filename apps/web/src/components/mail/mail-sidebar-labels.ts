import type { MailboxAccountLabel } from "@invook/contracts";

export interface SidebarLabel {
  id: string;
  name: string;
  labelIds: string[];
}

export function listSidebarLabels(
  invookLabels: MailboxAccountLabel[],
): SidebarLabel[] {
  const labelsByName = new Map<string, SidebarLabel>();
  for (const label of invookLabels) {
    if (label.systemKey === "important") continue;
    const merged = labelsByName.get(label.normalizedName);
    if (merged) merged.labelIds.push(label.id);
    else {
      labelsByName.set(label.normalizedName, {
        id: label.id,
        name: label.name,
        labelIds: [label.id],
      });
    }
  }
  return [...labelsByName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}
