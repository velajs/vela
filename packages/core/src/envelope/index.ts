/**
 * Barrel for the response-envelope surface: the pluggable envelope
 * (`./envelope`), the exception family + structured-error contracts
 * (`./errors`), and the boundary error-mapping pipeline (`./mappers`).
 */

export {
  defaultEnvelope,
  type ResponseEnvelope,
  type ResponseEnvelopeInfo,
  type ErrorMapper,
} from './envelope';

export {
  CrudException,
  InputValidationException,
  NotFoundException,
  ConflictException,
  UnauthorizedException,
  ForbiddenException,
  AggregationException,
  ConfigurationException,
  type CrudErrorCode,
  type StructuredError,
  type ValidationIssue,
} from './errors';

export {
  resolveStructuredError,
  statusForCode,
  INTERNAL_ERROR_MESSAGE,
} from './mappers';
