export type Default =
  | Mock[]
  | {
      context?: Context;
      mocks: Mock[];
    };

export type Scenarios = {
  [scenario: string]:
    | Mock[]
    | {
        group?: string;
        context?: Context;
        mocks: Mock[];
      };
};

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export type Override<TResponse> = {
  __override: ResponseProps<TResponse>;
};

export type ResponseFunction<TInput, TResponse> = (
  input: TInput & {
    updateContext: UpdateContext;
    context: Context;
  },
) => TResponse | Override<TResponse> | Promise<TResponse | Override<TResponse>>;

export type MockResponse<TInput, TResponse> =
  | TResponse
  | ResponseFunction<TInput, TResponse>;

export type HttpResponse = Record<string, any> | string | null;

export type ResponseProps<TResponse> = {
  response?: TResponse;
  responseCode?: number;
  responseHeaders?: Record<string, string>;
  responseDelay?: number;
};

export type HttpMock = {
  url: string | RegExp;
  method: HttpMethod;
} & ResponseProps<
  MockResponse<
    {
      query: Record<string, string | Array<string>>;
      body: Record<string, any>;
      params: Record<string, string>;
    },
    HttpResponse
  >
>;

export type GraphQlResponse = {
  data?: null | Record<string, any>;
  errors?: Array<any>;
};

export type Operation = {
  type: 'query' | 'mutation';
  name: string;
} & ResponseProps<
  MockResponse<
    {
      variables: Record<string, any>;
    },
    GraphQlResponse | HttpResponse
  >
>;

export type GraphQlMock = {
  url: string;
  method: 'GRAPHQL';
  operations: Array<Operation>;
};

export type Mock = HttpMock | GraphQlMock;

export type Options = {
  port?: number;
  uiPath?: string;
  modifyScenariosPath?: string;
  resetScenariosPath?: string;
  cookieMode?: boolean;
};

export type Context = Record<string, any>;

export type UpdateContext = (
  partialContext: Context | ((context: Context) => Context),
) => Context;
