import { z } from 'zod';
import { defineDto } from '../validation';

const UserDto = defineDto(z.object({ name: z.string(), age: z.number() }));
const LengthDto = defineDto(z.string().transform((value) => value.length));

export function verifySchemaDtoTypes(value: unknown): void {
  const user = UserDto.parse(value);
  const name: string = user.name;
  const age: number = user.age;
  const length: number = LengthDto.parse(value);
  void [name, age, length];

  // @ts-expect-error Schema descriptors cannot manufacture populated class instances.
  new UserDto();
  // @ts-expect-error Parsed fields are inferred from the schema, not chosen by a consumer.
  const wrongName: number = user.name;
  // @ts-expect-error Transform outputs retain their parsed output type.
  const rawString: string = LengthDto.parse(value);
  // @ts-expect-error The parser's output cannot be overridden with a result type argument.
  UserDto.parse<Date>(value);
  void [wrongName, rawString];
}
