import { Module } from '@knead-js/core';
import { TodosModule } from './todos.module.js';

@Module({ imports: [TodosModule] })
export class AppModule {}
