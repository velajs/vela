import assert from 'node:assert/strict';
import { Controller, Get, Inject, Module, UseGuards, VelaFactory } from '@velajs/vela';
import { ApiExclude, OpenApiModule, OpenApiService } from '@velajs/vela/openapi';

function route(controller, method, path) {
  Get(path)(
    controller.prototype,
    method,
    Object.getOwnPropertyDescriptor(controller.prototype, method),
  );
}

export async function verifyOpenApi() {
  class RecordsController {
    list() {
      return [];
    }
  }
  Controller('/records')(RecordsController);
  route(RecordsController, 'list', '/');
  const guard = {
    canActivate: (context) =>
      context.switchToHttp().getRequest().headers.get('x-docs') === 'allowed',
  };
  class AppModule {}
  Module({
    controllers: [RecordsController],
    imports: [
      OpenApiModule.forRoot({
        ui: 'scalar',
        decorators: [UseGuards(guard)],
        uiOptions: {
          scriptUrl: '/assets/reference.js',
          headers: { 'content-security-policy': "default-src 'self'" },
        },
      }),
    ],
  })(AppModule);
  const app = await VelaFactory.create(AppModule, { globalPrefix: '/api', diagnostics: 'throw' });
  try {
    for (const path of ['/api/openapi.json', '/api/docs']) {
      assert.equal((await app.fetch(new Request(`https://fixture.test${path}`))).status, 403);
      const response = await app.fetch(
        new Request(`https://fixture.test${path}`, { headers: { 'x-docs': 'allowed' } }),
      );
      assert.equal(response.status, 200);
      if (path.endsWith('.json'))
        assert.deepEqual(Object.keys((await response.json()).paths), ['/api/records']);
      else {
        assert.equal(response.headers.get('content-security-policy'), "default-src 'self'");
        const page = await response.text();
        assert.ok(page.includes('data-url="/api/openapi.json"'));
        assert.ok(page.includes('/assets/reference.js'));
      }
    }
  } finally {
    await app.close();
  }

  class CustomController {
    constructor(docs) {
      this.docs = docs;
    }
    read() {
      return this.docs.getDocument();
    }
  }
  Inject(OpenApiService)(CustomController, undefined, 0);
  Controller('/schema')(CustomController);
  ApiExclude()(CustomController);
  route(CustomController, 'read', '/');
  class CustomModule {}
  Module({
    imports: [OpenApiModule.forRoot({ mount: false, info: { title: 'Custom reference' } })],
    controllers: [RecordsController, CustomController],
  })(CustomModule);
  const custom = await VelaFactory.create(CustomModule, { diagnostics: 'throw' });
  try {
    const response = await custom.fetch(new Request('https://fixture.test/schema'));
    assert.equal(response.status, 200);
    const document = await response.json();
    assert.equal(document.info.title, 'Custom reference');
    assert.deepEqual(Object.keys(document.paths), ['/records']);
    assert.equal(
      (await custom.fetch(new Request('https://fixture.test/openapi.json'))).status,
      404,
    );
  } finally {
    await custom.close();
  }
}
