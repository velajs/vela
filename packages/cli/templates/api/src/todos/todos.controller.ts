import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post } from '@velajs/vela';
import { z } from 'zod';
import { CreateTodo, Todo, UpdateTodo } from './todo.schemas.js';
import { TodosService } from './todos.service.js';

@Controller('/todos')
export class TodosController {
  readonly #todos: TodosService;

  constructor(todos: TodosService) {
    this.#todos = todos;
  }

  // `response` shapes and documents the result; the handler must return it.
  @Get({ response: z.array(Todo) })
  list(): Promise<Todo[]> {
    return this.#todos.list();
  }

  @Get('/:id', { response: Todo })
  async find(@Param('id') id: string): Promise<Todo> {
    const todo = await this.#todos.find(id);
    if (!todo) throw new NotFoundException(`Todo ${id} not found`);
    return todo;
  }

  // A schema argument validates the JSON body; an invalid one answers 400.
  // POST answers 201.
  @Post({ response: Todo })
  create(@Body(CreateTodo) body: CreateTodo): Promise<Todo> {
    return this.#todos.create(body);
  }

  @Patch('/:id', { response: Todo })
  async update(@Param('id') id: string, @Body(UpdateTodo) body: UpdateTodo): Promise<Todo> {
    const todo = await this.#todos.update(id, body);
    if (!todo) throw new NotFoundException(`Todo ${id} not found`);
    return todo;
  }

  // `response: null` answers 204 with no body.
  @Delete('/:id', { response: null })
  async remove(@Param('id') id: string): Promise<void> {
    if (!(await this.#todos.remove(id))) throw new NotFoundException(`Todo ${id} not found`);
  }
}
