export type Path = (string | number)[];

export interface GraphTask {
  id: string;
  dependsOn: readonly unknown[];
  path: Path;
}

// Iterative graph walks avoid a call-stack limit on large authored Plans.
export function cycles(tasks: GraphTask[]): { ids: string[]; path: Path }[] {
  const graph = new Map(
    tasks.map((task) => [
      task.id,
      task.dependsOn.filter(
        (value): value is string => typeof value === "string",
      ),
    ]),
  );
  const visited = new Set<string>();
  const finished: string[] = [];
  for (const id of graph.keys()) {
    const stack: [string, boolean][] = [[id, false]];
    while (stack.length) {
      const entry = stack.pop();
      if (!entry) break;
      const [current, finish] = entry;
      if (finish) {
        finished.push(current);
      } else if (!visited.has(current)) {
        visited.add(current);
        stack.push([current, true]);
        for (const dependency of graph.get(current) ?? []) {
          if (graph.has(dependency) && !visited.has(dependency))
            stack.push([dependency, false]);
        }
      }
    }
  }
  const reverse = new Map<string, string[]>(
    [...graph.keys()].map((id) => [id, []]),
  );
  for (const [id, dependencies] of graph) {
    for (const dependency of dependencies) reverse.get(dependency)?.push(id);
  }
  const assigned = new Set<string>();
  const result: { ids: string[]; path: Path }[] = [];
  for (const id of finished.reverse()) {
    if (assigned.has(id)) continue;
    const component = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const current = stack.pop();
      if (current === undefined || assigned.has(current)) continue;
      assigned.add(current);
      component.add(current);
      for (const dependent of reverse.get(current) ?? []) stack.push(dependent);
    }
    if (component.size === 1 && !graph.get(id)?.includes(id)) continue;
    const members = tasks.filter((task) => component.has(task.id));
    const first = members.find((task) =>
      task.dependsOn.some(
        (dependency) =>
          typeof dependency === "string" && component.has(dependency),
      ),
    );
    if (!first) continue;
    const index = first.dependsOn.findIndex(
      (dependency) =>
        typeof dependency === "string" && component.has(dependency),
    );
    result.push({
      ids: [...new Set(members.map((task) => task.id))],
      path: [...first.path, "dependsOn", index],
    });
  }
  return result;
}
