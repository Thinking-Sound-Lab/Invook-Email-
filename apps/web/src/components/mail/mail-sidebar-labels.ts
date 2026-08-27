import { normalizeInvookLabelName, type InvookLabel } from "@invook/contracts";

export interface SidebarLabel {
  id: string;
  name: string;
  labelIds: string[];
}

export function listSidebarLabels(invookLabels: InvookLabel[]): SidebarLabel[] {
  const labelsByName = new Map<string, SidebarLabel>();
  for (const label of invookLabels) {
    if (label.systemKey === "important") continue;
    const labelName = normalizeInvookLabelName(label.name);
    const merged = labelsByName.get(labelName);
    if (merged) merged.labelIds.push(label.id);
    else {
      labelsByName.set(labelName, {
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
