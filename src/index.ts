import express, { Router, Request, Response } from 'express';
import nunjucks from 'nunjucks';
import path from 'path';

import { Scenarios, Options, Mock, ResponseFunction } from './types';

export * from './types';

type Groups = Array<{
  name: string;
  noneChecked: boolean;
  scenarios: Array<{
    name: string;
    checked: boolean;
  }>;
}>;

type Input = {
  default: Mock[];
  scenarios?: Scenarios;
  options?: Options;
};

export function run({
  default: defaultMocks,
  scenarios: scenarioMocks = {},
  options = {},
}: Input) {
  let selectedScenarios: string[] = [];
  let router = createRouter({
    defaultMocks,
    scenarioMocks,
    selectedScenarios,
  });
  const app = express();
  const scenarioNames = Object.keys(scenarioMocks);
  const groupNames = Object.values(scenarioMocks).reduce<string[]>(
    (result, mock) => {
      if (Array.isArray(mock) || result.includes(mock.group)) {
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

  app.use(express.static(path.join(__dirname, 'assets')));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get('/', (_, res) => {
    const { groups, other } = getPageVariables(
      scenarioMocks,
      selectedScenarios,
    );

    res.render('index.njk', {
      groups,
      other,
    });
  });

  app.post('/', ({ body: { scenarios: scenariosBody, ...rest } }, res) => {
    let updatedScenarios = groupNames.reduce<string[]>((result, groupName) => {
      if (rest[groupName]) {
        result.push(rest[groupName]);
      }

      return result;
    }, []);
    updatedScenarios = updatedScenarios.concat(
      scenariosBody == null
        ? []
        : typeof scenariosBody === 'string'
        ? [scenariosBody]
        : scenariosBody,
    );

    const { groups, other } = getPageVariables(
      scenarioMocks,
      selectedScenarios,
    );

    res.render('index.njk', {
      groups,
      other,
      updatedScenarios,
    });

    router = createRouter({
      defaultMocks,
      scenarioMocks,
      selectedScenarios: updatedScenarios,
    });

    updateScenarios(updatedScenarios);
  });

  app.put(
    '/modify-scenarios',
    ({ body: { scenarios: scenariosBody } }, res) => {
      if (!Array.isArray(scenariosBody)) {
        res.status(400).json({
          message:
            '"scenarios" must be an array of scenario names (empty array allowed)',
        });
        return;
      }

      for (const scenario of scenariosBody) {
        if (!scenarioNames.includes(scenario)) {
          res.status(400).json({
            message: `Scenario "${scenario}" does not exist`,
          });
          return;
        }
      }

      try {
        router = createRouter({
          defaultMocks,
          scenarioMocks,
          selectedScenarios: scenariosBody,
        });
      } catch ({ message }) {
        res.status(500).json({ message });
        return;
      }

      updateScenarios(scenariosBody);

      res.sendStatus(204);
    },
  );

  app.use(function middleware(req, res, next) {
    router(req, res, next);
  });

  const { port = 3000 } = options;

  return app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });

  function updateScenarios(updatedScenarios: string[]) {
    selectedScenarios = updatedScenarios;
    console.log('Selected scenarios', updatedScenarios);
  }
}

function addDelay(delay: number) {
  return new Promise(res => setTimeout(res, delay));
}

function reduceAllMocksForScenarios({
  defaultMocks,
  scenarioMocks,
  selectedScenarios,
}: {
  defaultMocks: Mock[];
  scenarioMocks: Scenarios;
  selectedScenarios: string[];
}): Mock[] {
  if (selectedScenarios.length === 0) {
    return defaultMocks;
  }

  const { reducedMocks } = selectedScenarios.reduce<{
    groups: Record<string, string>;
    reducedMocks: Mock[];
  }>(
    (result, selectedScenario) => {
      const mocks = scenarioMocks[selectedScenario];

      if (!mocks) {
        return result;
      }

      if (Array.isArray(mocks)) {
        result.reducedMocks = result.reducedMocks.concat(mocks);

        return result;
      }

      if (result.groups[mocks.group]) {
        throw new Error(
          `Scenario "${selectedScenario}" cannot be selected, because scenario "${
            result.groups[mocks.group]
          }" from group "${mocks.group}" has already been selected`,
        );
      }

      result.groups[mocks.group] = selectedScenario;
      result.reducedMocks = result.reducedMocks.concat(mocks.mocks);

      return result;
    },
    { groups: {}, reducedMocks: [] },
  );

  return defaultMocks
    .filter(
      defaultMock =>
        !reducedMocks.find(
          mock =>
            mock.url.toString() === defaultMock.url.toString() &&
            defaultMock.method === mock.method,
        ),
    )
    .concat(reducedMocks);
}

type CreateRouterInput = {
  defaultMocks: Mock[];
  scenarioMocks: Scenarios;
  selectedScenarios: string[];
};

function createRouter({
  defaultMocks,
  scenarioMocks,
  selectedScenarios,
}: CreateRouterInput) {
  const router = Router();

  const mocks: Mock[] = reduceAllMocksForScenarios({
    defaultMocks,
    scenarioMocks,
    selectedScenarios,
  });

  mocks.forEach(
    ({
      method,
      url,
      response,
      responseCode = 200,
      responseHeaders,
      delay = 0,
    }) => {
      function handler(req: Request, res: Response) {
        if (typeof response === 'function') {
          (response as ResponseFunction)(req).then(result => {
            res
              .set(result.responseHeaders)
              .status(result.responseCode || 200)
              .json(result.response);
          });

          return;
        }

        addDelay(delay).then(() => {
          res
            .set(responseHeaders)
            .status(responseCode)
            .json(response);
        });
      }

      switch (method) {
        case 'GET':
          router.get(url, function routeGet(req, res) {
            handler(req, res);
          });
          break;
        case 'POST':
          router.post(url, function routePost(req, res) {
            handler(req, res);
          });
          break;
        case 'PUT':
          router.put(url, function routePut(req, res) {
            handler(req, res);
          });
          break;
        case 'DELETE':
          router.delete(url, function routeDelete(req, res) {
            handler(req, res);
          });
          break;
        default:
          throw new Error(
            `Unrecognised HTTP method ${method} - please check your mock configuration`,
          );
      }
    },
  );

  return router;
}

function getPageVariables(
  scenarioMocks: Scenarios,
  selectedScenarios: string[],
) {
  const { other, ...groupedScenarios } = Object.entries(scenarioMocks).reduce<{
    other: string[];
    [key: string]: string[];
  }>(
    (result, [scenarioName, scenarioMock]) => {
      if (Array.isArray(scenarioMock)) {
        result.other.push(scenarioName);

        return result;
      }

      const { group } = scenarioMock;

      if (!result[group]) {
        result[group] = [];
      }

      result[group].push(scenarioName);

      return result;
    },
    { other: [] },
  );

  const groups = Object.entries(groupedScenarios).reduce<Groups>(
    (result, [group, groupScenarios]) => {
      let noneChecked = true;
      const scenarios2 = groupScenarios.map(scenario => {
        const checked = selectedScenarios.includes(scenario);
        if (checked) {
          noneChecked = false;
        }

        return {
          name: scenario,
          checked,
        };
      });

      result.push({
        noneChecked,
        name: group,
        scenarios: scenarios2,
      });

      return result;
    },
    [],
  );

  return {
    groups,
    other: other.map(scenario => ({
      name: scenario,
      checked: selectedScenarios.includes(scenario),
    })),
  };
}
