import {
  type DynamicModule,
  MODULE_METADATA,
  type ModuleExport,
  type ModuleImport,
  type ModuleOptions,
} from './decorators.js';
import { ModuleDefinitionError } from './errors.js';
import { type ContainerState, ModuleInjector } from './injector.js';
import { getOwnMetadata } from './metadata.js';
import { normalizeProvider } from './providers.js';
import { type Token, type Type, tokenName } from './tokens.js';

export interface ModuleRef {
  readonly name: string;
  readonly metatype: Type;
  readonly injector: ModuleInjector;
  readonly controllers: readonly Type[];
  readonly global: boolean;
}

interface Definition {
  metatype: Type;
  options: ModuleOptions;
}

interface Node {
  key: object;
  def: Definition;
  injector: ModuleInjector;
  children: Node[];
}

function isDynamicModule(value: unknown): value is DynamicModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DynamicModule).module === 'function'
  );
}

function definitionOf(entry: unknown, parent: string, index: number): Definition {
  if (entry === undefined || entry === null) {
    throw new ModuleDefinitionError(
      `${parent} has ${String(entry)} in imports at index ${index}. This usually means a circular ` +
        'file import; check the import order of your module files.',
    );
  }
  if (typeof entry === 'function') {
    const options = getOwnMetadata(entry, MODULE_METADATA);
    if (!options) {
      throw new ModuleDefinitionError(
        `${parent} imports ${entry.name || 'an anonymous class'}, which is not a module. Did you forget @Module()?`,
      );
    }
    return { metatype: entry as Type, options };
  }
  if (isDynamicModule(entry)) {
    const base = getOwnMetadata(entry.module, MODULE_METADATA) ?? {};
    return {
      metatype: entry.module,
      options: {
        imports: [...(base.imports ?? []), ...(entry.imports ?? [])],
        providers: [...(base.providers ?? []), ...(entry.providers ?? [])],
        controllers: [...(base.controllers ?? []), ...(entry.controllers ?? [])],
        exports: [...(base.exports ?? []), ...(entry.exports ?? [])],
        global: entry.global ?? base.global ?? false,
      },
    };
  }
  throw new ModuleDefinitionError(
    `${parent} imports ${String(entry)} at index ${index}, which is neither a module class nor a dynamic module.`,
  );
}

function matchesImport(child: Node, entry: ModuleExport): boolean {
  if (child.key === entry || child.def.metatype === entry) return true;
  return isDynamicModule(entry) && child.def.metatype === entry.module;
}

function describeExport(entry: ModuleExport): string {
  return isDynamicModule(entry) ? `${entry.module.name} (dynamic module)` : tokenName(entry);
}

function unresolvedExport(node: Node, entry: ModuleExport): ModuleDefinitionError {
  return new ModuleDefinitionError(
    `${node.def.metatype.name} exports ${describeExport(entry)}, which it neither provides nor imports.`,
  );
}

function computeExports(node: Node): void {
  const { injector, def } = node;
  for (const entry of def.options.exports ?? []) {
    const exact = node.children.filter((c) => c.key === entry);
    const matched = exact.length > 0 ? exact : node.children.filter((c) => matchesImport(c, entry));
    if (matched.length > 0) {
      for (const child of matched) {
        for (const [token, owner] of child.injector.exported) injector.exported.set(token, owner);
      }
      continue;
    }
    if (isDynamicModule(entry)) throw unresolvedExport(node, entry);
    const token = entry as Token;
    if (injector.records.has(token)) {
      injector.exported.set(token, injector);
      continue;
    }
    const via = node.children.find((c) => c.injector.exported.has(token));
    if (via) {
      injector.exported.set(token, via.injector.exported.get(token)!);
      continue;
    }
    throw unresolvedExport(node, entry);
  }
}

export function buildModuleGraph(
  root: ModuleImport,
  globals: readonly ModuleImport[],
  state: ContainerState,
): { modules: ModuleRef[]; root: ModuleRef } {
  const nodes = new Map<unknown, Node>();
  const order: Node[] = [];
  const path: Node[] = [];

  const visit = (entry: unknown, parent: string, index: number): Node => {
    const known = nodes.get(entry);
    if (known) {
      if (path.includes(known)) {
        const cycle = [...path.slice(path.indexOf(known)), known].map((n) => n.def.metatype.name);
        throw new ModuleDefinitionError(`Circular module import: ${cycle.join(' → ')}`);
      }
      return known;
    }
    const def = definitionOf(entry, parent, index);
    const node: Node = {
      key: entry as object,
      def,
      injector: new ModuleInjector(def.metatype.name, state),
      children: [],
    };
    nodes.set(entry, node);
    path.push(node);
    (def.options.imports ?? []).forEach((child, i) => {
      const c = visit(child, def.metatype.name, i);
      node.children.push(c);
      node.injector.imports.push(c.injector);
    });
    path.pop();
    order.push(node);
    return node;
  };

  globals.forEach((g, i) => {
    visit(g, '<global modules>', i);
  });
  if (root === undefined || root === null) {
    throw new ModuleDefinitionError(
      `The root module is ${String(root)}. This usually means a circular file import; check the import order of your module files.`,
    );
  }
  const rootNode = visit(root, '<root>', 0);

  for (const node of order) {
    for (const p of node.def.options.providers ?? [])
      node.injector.addProvider(normalizeProvider(p));
    for (const c of node.def.options.controllers ?? []) {
      node.injector.addProvider({
        kind: 'class',
        token: c,
        useClass: c,
        scope: 'singleton',
        multi: false,
      });
    }
  }
  for (const node of order) computeExports(node);
  state.globals = order.filter((n) => n.def.options.global).map((n) => n.injector);

  const refs = new Map<Node, ModuleRef>(
    order.map((n) => [
      n,
      {
        name: n.def.metatype.name,
        metatype: n.def.metatype,
        injector: n.injector,
        controllers: [...(n.def.options.controllers ?? [])],
        global: n.def.options.global ?? false,
      },
    ]),
  );
  return { modules: order.map((n) => refs.get(n)!), root: refs.get(rootNode)! };
}
