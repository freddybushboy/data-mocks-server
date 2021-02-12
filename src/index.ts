import { pathToRegexp, Key } from 'path-to-regexp';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Request, Response, NextFunction } from 'express';
import nunjucks from 'nunjucks';
import path from 'path';
import { transform } from 'server-with-kill';

import { modifyScenarios, resetScenarios } from './apis';
import {
  getGraphQlMocks,
  createGraphQlHandler,
  createGraphQlRequestHandler,
} from './graph-ql';
import { getHttpMocks } from './http';
import {
  Mock,
  Options,
  Scenarios,
  Default,
  Context,
  HttpMock,
  GraphQlMock,
} from './types';
import { getUi, updateUi } from './ui';
import { createHandler } from './create-handler';

export * from './types';
export { run };

function run({
  default: defaultMocks,
  scenarios: scenarioMocks = {},
  options = {},
}: {
  default: Default;
  scenarios?: Scenarios;
  options?: Options;
}) {
  let selectedScenarios: string[] = [];
  let currentContext: Record<string, any> = getInitialContext2({
    defaultMocks,
    scenarioMocks,
    scenarios: selectedScenarios,
  });
  const {
    port = 3000,
    uiPath = '/',
    modifyScenariosPath = '/modify-scenarios',
    resetScenariosPath = '/reset-scenarios',
    cookieMode = false,
  } = options;

  const app = express();
  const scenarioNames = Object.keys(scenarioMocks);
  const groupNames = Object.values(scenarioMocks).reduce<string[]>(
    (result, mock) => {
      if (
        Array.isArray(mock) ||
        mock.group == null ||
        result.includes(mock.group)
      ) {
        return result;
      }

      result.push(mock.group);
      return result;
    },
    [],
  );

  nunjucks.configure(__dirname, {
    autoescape: true,
    express: app,
  });

  app.use(cors());
  app.use(cookieParser());
  app.use(uiPath, express.static(path.join(__dirname, 'assets')));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(express.text({ type: 'application/graphql' }));

  app.get(uiPath, (req, res, next) =>
    getUi({
      scenarioMocks,
      getScenarios: () => {
        if (cookieMode) {
          return req.cookies.scenarios ? JSON.parse(req.cookies.scenarios) : [];
        }

        return selectedScenarios;
      },
    })(req, res, next),
  );

  app.post(uiPath, (req, res, next) =>
    updateUi({
      groupNames,
      scenarioNames,
      scenarioMocks,
      updateScenarios: updateScenarios(res),
    })(req, res, next),
  );

  app.put(modifyScenariosPath, (req, res, next) =>
    modifyScenarios({
      scenarioNames,
      scenarioMocks,
      updateScenarios: updateScenarios(res),
    })(req, res, next),
  );

  app.put(resetScenariosPath, (req, res, next) =>
    resetScenarios({
      updateScenarios: updateScenarios(res),
    })(req, res, next),
  );

  app.use((req, res, next) => {
    router({
      req,
      res,
      next,
      getScenarios: () => {
        if (!cookieMode) {
          return selectedScenarios;
        }

        if (req.cookies.scenarios) {
          return JSON.parse(req.cookies.scenarios);
        }

        return [];
      },
      defaultMocks,
      scenarioMocks,
      getContext: (initialContext: Record<string, any>) => {
        if (!cookieMode) {
          return currentContext;
        }

        if (req.cookies.context) {
          return JSON.parse(req.cookies.context);
        }

        return initialContext;
      },
      setContext: (ctx: Record<string, any>) => {
        if (cookieMode) {
          res.cookie('context', JSON.stringify(ctx), {
            encode: String,
          });
        } else {
          currentContext = ctx;
        }
      },
    });
  });

  return transform(
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    }),
  );

  function updateScenarios(res: Response) {
    return (updatedScenarios: string[]) => {
      const context = getInitialContext2({
        defaultMocks,
        scenarioMocks,
        scenarios: updatedScenarios,
      });

      if (cookieMode) {
        res.cookie('context', JSON.stringify(context), {
          encode: String,
        });
        res.cookie('scenarios', JSON.stringify(updatedScenarios), {
          encode: String,
        });

        return;
      }

      currentContext = context;
      selectedScenarios = updatedScenarios;

      return updatedScenarios;
    };
  }
}

function updateContext(
  context: Context,
  partialContext: Context | ((context: Context) => Context),
) {
  const newContext = {
    ...context,
    ...(typeof partialContext === 'function'
      ? partialContext(context)
      : partialContext),
  };

  return newContext;
}

function mergeMocks(scenarioMocks: ({ mocks: Mock[] } | Mock[])[]) {
  return scenarioMocks.reduce<Mock[]>(
    (result, scenarioMock) =>
      result.concat(
        Array.isArray(scenarioMock) ? scenarioMock : scenarioMock.mocks,
      ),
    [],
  );
}

function getInitialContext(mocks: ({ context?: Context } | any[])[]) {
  let context: Context = {};
  mocks.forEach(mock => {
    if (!Array.isArray(mock) && mock.context) {
      context = { ...context, ...mock.context };
    }
  });

  return context;
}

function getMocks({
  defaultMocks,
  scenarioMocks,
  scenarios,
}: {
  defaultMocks: Default;
  scenarioMocks: Scenarios;
  scenarios: string[];
}) {
  const defaultAndScenarioMocks = getDefaultAndScenarioMocks({
    defaultMocks,
    scenarioMocks,
    scenarios,
  });

  const mocks = mergeMocks(defaultAndScenarioMocks);
  const httpMocks = getHttpMocks(mocks);
  const graphQlMocks = getGraphQlMocks(mocks);

  return { httpMocks, graphQlMocks };
}

function getDefaultAndScenarioMocks({
  defaultMocks,
  scenarioMocks,
  scenarios,
}: {
  defaultMocks: Default;
  scenarioMocks: Scenarios;
  scenarios: string[];
}) {
  return [defaultMocks].concat(
    scenarios.map(scenario => scenarioMocks[scenario]),
  );
}

function getInitialContext2({
  defaultMocks,
  scenarioMocks,
  scenarios,
}: {
  defaultMocks: Default;
  scenarioMocks: Scenarios;
  scenarios: string[];
}) {
  const defaultAndScenarioMocks = getDefaultAndScenarioMocks({
    defaultMocks,
    scenarioMocks,
    scenarios,
  });

  return getInitialContext(defaultAndScenarioMocks);
}

function getHttpMockAndParams(req: Request, httpMocks: HttpMock[]) {
  let params: Record<string, string>;

  const httpMock =
    httpMocks.find(mock => {
      const { match, params: mockParams } = getMatchAndParams(
        req.path,
        mock.url,
      );
      params = mockParams;

      return mock.method === req.method && match;
    }) || null;

  return {
    httpMock,
    // eslint-disable-next-line @typescript-eslint/ban-ts-ignore
    // @ts-ignore This will be set by the "Array.find" method
    params,
  };
}

function getMatchAndParams(reqPath: string, mockUrl: string | RegExp) {
  const params: Record<string, string> = {};
  const keys: Key[] = [];
  const regex = pathToRegexp(mockUrl, keys);
  const match = regex.exec(reqPath);

  if (!match) {
    return {
      match: false,
      params,
    };
  }

  for (let i = 1; i < match.length; i++) {
    const key = keys[i - 1];
    const prop = key.name;

    params[prop] = decodeURIComponent(match[i]);
  }

  return {
    match: true,
    params,
  };
}

function router({
  req,
  res,
  next,
  getScenarios,
  defaultMocks,
  scenarioMocks,
  getContext,
  setContext,
}: {
  req: Request;
  res: Response;
  next: NextFunction;
  getScenarios: () => string[];
  defaultMocks: Default;
  scenarioMocks: Scenarios;
  getContext: (initialContext: Context) => Context;
  setContext: (context: Context) => void;
}) {
  const scenarios: string[] = getScenarios();

  const { httpMocks, graphQlMocks } = getMocks({
    defaultMocks,
    scenarioMocks,
    scenarios,
  });
  const initialContext = getInitialContext2({
    defaultMocks,
    scenarioMocks,
    scenarios,
  });

  let context: Record<string, any> = getContext(initialContext);

  const graphQlMock = getGraphQlMock(req, graphQlMocks);
  const { httpMock, params } = getHttpMockAndParams(req, httpMocks);

  if (graphQlMock) {
    const queries = graphQlMock.operations
      .filter(({ type }) => type === 'query')
      .map(operation =>
        createGraphQlHandler({
          ...operation,
          updateContext: localUpdateContext,
          getContext: () => context,
        }),
      );

    if (req.method === 'GET') {
      const handler = createGraphQlRequestHandler(queries);
      handler(req, res, next);
      return;
    }

    if (req.method === 'POST') {
      const mutations = graphQlMock.operations
        .filter(({ type }) => type === 'mutation')
        .map(operation =>
          createGraphQlHandler({
            ...operation,
            updateContext: localUpdateContext,
            getContext: () => context,
          }),
        );
      const handler = createGraphQlRequestHandler(queries.concat(mutations));
      handler(req, res, next);
      return;
    }

    // req.method doesn't make sense for GraphQL - default 404 from express
    next();

    return;
  }

  if (!httpMock) {
    // Default 404 from express
    next();

    return;
  }

  // Using router.all() so need to create params manually
  req.params = params;

  const handler = createHandler({
    ...httpMock,
    getContext: () => context,
    updateContext: localUpdateContext,
  });

  handler(req, res);

  function localUpdateContext(
    partialContext: Context | ((context: Context) => Context),
  ) {
    context = updateContext(context, partialContext);

    setContext(context);

    return context;
  }
}

function getGraphQlMock(req: Request, graphqlMocks: GraphQlMock[]) {
  return graphqlMocks.find(graphQlMock => graphQlMock.url === req.path) || null;
}
