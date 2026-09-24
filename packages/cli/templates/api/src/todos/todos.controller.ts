import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@velajs/vela';
import { CreateTodo, UpdateTodo, type Todo } from './todo.schemas.js';
import { TodosService } from './todos.service.js';

@Controller('/todos')
export class TodosController {
  readonly #todos: TodosService;

  constructor(todos: TodosService) {
    this.#todos = todos;
  }

  @Get()
  list(): Promise<Todo[]> {
    return this.#todos.list();
  }

  @Get('/:id')
  async find(@Param('id') id: string): Promise<Todo> {
    const todo = await this.#todos.find(id);
    if (!todo) throw new NotFoundException(`Todo ${id} not found`);
    return todo;
  }

  // A schema argument validates the JSON body; an invalid one answers 400.
  @Post()
  create(@Body(CreateTodo) body: CreateTodo): Promise<Todo> {
    return this.#todos.create(body);
  }

  @Patch('/:id')
  async update(@Param('id') id: string, @Body(UpdateTodo) body: UpdateTodo): Promise<Todo> {
    const todo = await this.#todos.update(id, body);
    if (!todo) throw new NotFoundException(`Todo ${id} not found`);
    return todo;
  }

  @Delete('/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    if (!(await this.#todos.remove(id))) throw new NotFoundException(`Todo ${id} not found`);
  }
}
