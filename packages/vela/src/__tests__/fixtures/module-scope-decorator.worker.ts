import { Reflector, getMetadata } from '../../index';

// workerd evaluates this module in global scope, where generating random
// values throws. Typed decorators are conventionally declared right here.
const Audience = Reflector.createDecorator<string>();
const Region = Reflector.createDecorator<string>();

class Report {}
Audience('internal')(Report);

export default {
  fetch(): Response {
    return Response.json({
      distinct: Audience.KEY !== Region.KEY,
      audience: getMetadata<string>(Audience.KEY, Report),
    });
  },
};
