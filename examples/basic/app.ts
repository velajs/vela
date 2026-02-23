import {
  VelaFactory,
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  Injectable,
  Module,
  UseGuards,
  UseInterceptors,
  ParseIntPipe,
  NotFoundException,
} from '@velajs/vela';
import type {
  CanActivate,
  ExecutionContext,
  NestInterceptor,
  CallHandler,
  OnModuleInit,
} from '@velajs/vela';

// --- Services ---

@Injectable()
class UserService implements OnModuleInit {
  private users = [
    { id: 1, name: 'Alice', email: 'alice@example.com' },
    { id: 2, name: 'Bob', email: 'bob@example.com' },
  ];

  onModuleInit() {
    console.log('UserService initialized with', this.users.length, 'users');
  }

  findAll(search?: string) {
    if (search) {
      return this.users.filter((u) => u.name.toLowerCase().includes(search.toLowerCase()));
    }
    return this.users;
  }

  findOne(id: number) {
    const user = this.users.find((u) => u.id === id);
    if (!user) throw new NotFoundException(`User #${id} not found`);
    return user;
  }

  create(data: { name: string; email: string }) {
    const user = { id: this.users.length + 1, ...data };
    this.users.push(user);
    return user;
  }

  remove(id: number) {
    const index = this.users.findIndex((u) => u.id === id);
    if (index === -1) throw new NotFoundException(`User #${id} not found`);
    this.users.splice(index, 1);
    return null;
  }
}

// --- Guards ---

class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.getRequest();
    return req.headers.get('authorization') === 'Bearer secret-token';
  }
}

// --- Interceptors ---

class LoggingInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler) {
    const start = Date.now();
    const result = await next.handle();
    const ms = Date.now() - start;
    console.log(`${context.getClass().name}.${String(context.getHandler())} - ${ms}ms`);
    return result;
  }
}

// --- Controllers ---

@Controller('/users')
@UseInterceptors(new LoggingInterceptor())
class UserController {
  constructor(private userService: UserService) {}

  @Get()
  findAll(@Query('search') search?: string) {
    return this.userService.findAll(search);
  }

  @Get('/:id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.userService.findOne(id);
  }

  @Post()
  @UseGuards(new AuthGuard())
  create(@Body() body: { name: string; email: string }) {
    return this.userService.create(body);
  }

  @Delete('/:id')
  @UseGuards(new AuthGuard())
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.userService.remove(id);
  }
}

// --- Module ---

@Module({
  providers: [UserService],
  controllers: [UserController],
})
class AppModule {}

// --- Bootstrap ---

const app = await VelaFactory.create(AppModule);

// Edge-compatible: export default with .fetch
export default app;

// For local testing:
// const hono = app.getHonoApp();
// const res = await hono.request('/users');
// console.log(await res.json());
