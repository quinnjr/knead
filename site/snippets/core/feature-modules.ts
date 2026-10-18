import { Injectable, inject, Module } from '@knead-js/core';

// #region database
@Injectable()
export class Database {
  query(sql: string): string[] {
    return [`result of ${sql}`];
  }
}

// Only for DatabaseModule's own use: not exported.
@Injectable()
export class ConnectionPool {
  readonly size = 10;
}

@Module({
  providers: [Database, ConnectionPool],
  exports: [Database],
})
export class DatabaseModule {}
// #endregion database

// #region users
@Injectable()
export class UsersService {
  readonly db = inject(Database);

  findAll(): string[] {
    return this.db.query('select * from users');
  }
}

@Module({
  imports: [DatabaseModule],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
// #endregion users

// #region app
@Module({ imports: [UsersModule] })
export class AppModule {}
// #endregion app
