import { GraphQLRuntime, printSortedSchema } from '@knead-js/graphql';
import { KneadFactory } from '@knead-js/http';
import { AppModule } from './app.module.js';

// Builds the schema without listening and writes it, for CI or codegen.
const app = await KneadFactory.create(AppModule, { development: false });
await Bun.write('schema.graphql', printSortedSchema(app.get(GraphQLRuntime).schema));
await app.close();
