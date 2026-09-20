import type { Context } from 'hono';
import { HttpCode, Redirect } from '../http/decorators';
import { mapRedirect, mapResponse } from '../http/response-mapper';
import type { HttpHandlerMeta } from '../registry/types';

function responseContracts(context: Context): void {
  HttpCode(201);
  Redirect('/created', 303);
  mapResponse(context, true, 202);
  mapRedirect(context, undefined, { url: '/target', statusCode: 308 });

  // @ts-expect-error Static HTTP statuses use Hono's declared status contract.
  HttpCode(777);
  // @ts-expect-error A redirect requires a redirect status.
  Redirect('/target', 200);
  // @ts-expect-error The mapper cannot reinterpret arbitrary numbers as valid HTTP statuses.
  mapResponse(context, 'invalid', 777);
  // @ts-expect-error Decorator metadata preserves the redirect status contract.
  const invalid: HttpHandlerMeta = { redirect: { url: '/target', statusCode: 200 } };
  void invalid;
}

void responseContracts;
